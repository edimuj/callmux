import type {
  AuthorizationConfig,
  AuthorizationRuleConfig,
} from "./types.js";

export interface AuthorizationPrincipal {
  kind: "bearer" | "oidc_jwt";
  id: string;
  subject?: string;
  scopes: string[];
  groups: string[];
}

interface AuthorizationDecision {
  allowed: boolean;
  code: string;
  reason: string;
  ruleId?: string;
  tool?: string;
}

function escapeRegexCharacter(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegex(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, escapeRegexCharacter))
    .join(".*");
  return new RegExp(`^${source}$`);
}

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  return patternToRegex(pattern).test(value);
}

function principalMatches(
  principalPatterns: string[] | undefined,
  principal: AuthorizationPrincipal
): boolean {
  if (!principalPatterns || principalPatterns.length === 0) return true;

  const principalValues = new Set<string>([
    `${principal.kind}:${principal.id}`,
    `id:${principal.id}`,
    `kind:${principal.kind}`,
    ...principal.scopes.map((scope) => `scope:${scope}`),
    ...principal.groups.map((group) => `group:${group}`),
  ]);
  if (principal.subject) {
    principalValues.add(`subject:${principal.subject}`);
  }

  for (const pattern of principalPatterns) {
    for (const value of principalValues) {
      if (patternMatches(pattern, value)) {
        return true;
      }
    }
  }

  return false;
}

function toolMatches(
  toolPatterns: string[] | undefined,
  toolName: string
): boolean {
  if (!toolPatterns || toolPatterns.length === 0) return true;
  return toolPatterns.some((pattern) => patternMatches(pattern, toolName));
}

interface MatchingRule {
  rule: AuthorizationRuleConfig;
  ruleId: string;
}

function matchingRules(
  policy: AuthorizationConfig,
  principal: AuthorizationPrincipal,
  toolName: string
): MatchingRule[] {
  const matches: MatchingRule[] = [];
  policy.rules.forEach((rule, index) => {
    if (!principalMatches(rule.principals, principal)) return;
    if (!toolMatches(rule.tools, toolName)) return;
    matches.push({
      rule,
      ruleId: rule.id ?? `rule_${index + 1}`,
    });
  });
  return matches;
}

export function evaluateToolAuthorization(
  policy: AuthorizationConfig | undefined,
  principal: AuthorizationPrincipal | undefined,
  toolNames: string[]
): AuthorizationDecision {
  if (!policy) {
    return {
      allowed: true,
      code: "authorization_disabled",
      reason: "Authorization policy is not configured",
    };
  }

  if (!principal) {
    return {
      allowed: false,
      code: "authorization_principal_missing",
      reason: "No authenticated principal is available for authorization",
    };
  }

  const defaultEffect = policy.defaultEffect ?? "allow";

  for (const toolName of toolNames) {
    const matches = matchingRules(policy, principal, toolName);
    const allowMatches = matches.filter((match) => match.rule.effect === "allow");
    const denyMatches = matches.filter((match) => match.rule.effect === "deny");

    if (allowMatches.length > 0 && denyMatches.length > 0) {
      return {
        allowed: false,
        code: "authorization_ambiguous",
        reason:
          "Conflicting allow and deny rules matched; failing closed",
        ruleId: denyMatches[0].ruleId,
        tool: toolName,
      };
    }

    if (denyMatches.length > 0) {
      return {
        allowed: false,
        code: "authorization_denied",
        reason: "Denied by matching policy rule",
        ruleId: denyMatches[0].ruleId,
        tool: toolName,
      };
    }

    if (allowMatches.length > 0) {
      continue;
    }

    if (defaultEffect === "deny") {
      return {
        allowed: false,
        code: "authorization_default_deny",
        reason: "No matching rule and policy default is deny",
        tool: toolName,
      };
    }
  }

  return {
    allowed: true,
    code: "authorization_allowed",
    reason: "All tool targets are allowed by policy",
  };
}
