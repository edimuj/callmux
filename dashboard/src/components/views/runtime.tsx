import { useStore } from '@/store'
import { Card } from '@/components/ui/card'

export function RuntimeView() {
  const snapshot = useStore((s) => s.snapshot)
  const json = JSON.stringify(snapshot?.status ?? {}, null, 2)
  return (
    <Card className="p-0">
      <pre className="m-0 max-h-[68vh] overflow-auto rounded-xl bg-[#0b1119] p-3 text-xs whitespace-pre-wrap text-blue-100">
        {json}
      </pre>
    </Card>
  )
}
