export interface RegistryEntry {
  name: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  envVars: EnvVarSpec[];
}

interface EnvVarSpec {
  name: string;
  description: string;
  required: boolean;
  hint?: string;
}

export const SERVER_REGISTRY: RegistryEntry[] = [
  {
    name: "github",
    label: "GitHub",
    description: "Issues, PRs, code search, file contents",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envVars: [
      {
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        description: "GitHub personal access token",
        required: true,
        hint: "Create at https://github.com/settings/tokens",
      },
    ],
  },
  {
    name: "filesystem",
    label: "Filesystem",
    description: "Read/write/search files in allowed directories",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    envVars: [],
  },
  {
    name: "brave-search",
    label: "Brave Search",
    description: "Web and local search via Brave API",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envVars: [
      {
        name: "BRAVE_API_KEY",
        description: "Brave Search API key",
        required: true,
        hint: "Get one at https://brave.com/search/api/",
      },
    ],
  },
  {
    name: "postgres",
    label: "PostgreSQL",
    description: "Query and manage PostgreSQL databases",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    envVars: [
      {
        name: "POSTGRES_CONNECTION_STRING",
        description: "PostgreSQL connection string",
        required: true,
        hint: "e.g. postgresql://user:pass@localhost:5432/dbname",
      },
    ],
  },
  {
    name: "linear",
    label: "Linear",
    description: "Issues, projects, teams in Linear",
    command: "npx",
    args: ["-y", "@linear/mcp-server"],
    envVars: [
      {
        name: "LINEAR_API_KEY",
        description: "Linear API key",
        required: true,
        hint: "Create at Linear → Settings → API",
      },
    ],
  },
  {
    name: "slack",
    label: "Slack",
    description: "Read/send messages, manage channels",
    command: "npx",
    args: ["-y", "@anthropic/mcp-server-slack"],
    envVars: [
      {
        name: "SLACK_BOT_TOKEN",
        description: "Slack bot token (xoxb-...)",
        required: true,
        hint: "Create a Slack app at https://api.slack.com/apps",
      },
    ],
  },
  {
    name: "puppeteer",
    label: "Puppeteer",
    description: "Browser automation — navigate, screenshot, interact",
    command: "npx",
    args: ["-y", "@anthropic/mcp-server-puppeteer"],
    envVars: [],
  },
];
