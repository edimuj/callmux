import { useEffect, useRef } from 'react'
import ApexCharts from 'apexcharts'

export interface ApexSeries {
  name: string
  color: string
  data: [number, number][]
}

interface ApexAreaProps {
  series: ApexSeries[]
  height?: number
  yFormatter?: (value: number) => string
  ariaLabel?: string
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

// Thin imperative wrapper around ApexCharts (the lib ships no React 19 binding;
// agent-relay drives it the same way). Re-renders update the existing chart in
// place so the live traffic chart animates smoothly instead of remounting.
export function ApexArea({ series, height = 260, yFormatter, ariaLabel }: ApexAreaProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ApexCharts | null>(null)

  useEffect(() => {
    if (!elRef.current) return
    const muted = cssVar('--muted-foreground', '#a7b0be')
    const border = cssVar('--border', 'rgba(255,255,255,0.1)')
    const options: ApexCharts.ApexOptions = {
      chart: {
        type: 'area',
        height,
        background: 'transparent',
        foreColor: muted,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: true, dynamicAnimation: { enabled: true } },
        fontFamily: 'inherit',
      },
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'gradient', gradient: { opacityFrom: 0.28, opacityTo: 0.02 } },
      dataLabels: { enabled: false },
      grid: { borderColor: border, strokeDashArray: 3, padding: { left: 8, right: 8 } },
      legend: { show: true, position: 'bottom', labels: { colors: muted }, markers: { size: 5 } },
      tooltip: { theme: 'dark', x: { format: 'HH:mm:ss' } },
      xaxis: {
        type: 'datetime',
        labels: { datetimeUTC: false, style: { colors: muted } },
        axisBorder: { color: border },
        axisTicks: { color: border },
      },
      yaxis: {
        labels: {
          style: { colors: muted },
          formatter: (value: number) => (yFormatter ? yFormatter(value) : String(Math.round(value))),
        },
        min: 0,
        forceNiceScale: true,
      },
      colors: series.map((s) => s.color),
      series: series.map((s) => ({ name: s.name, data: s.data })),
    }
    const chart = new ApexCharts(elRef.current, options)
    chart.render()
    chartRef.current = chart
    return () => {
      chart.destroy()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update series + colors on data change without a full remount.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.updateOptions(
      { colors: series.map((s) => s.color) },
      false,
      false,
    )
    chart.updateSeries(
      series.map((s) => ({ name: s.name, data: s.data })),
      true,
    )
  }, [series])

  return <div ref={elRef} role="img" aria-label={ariaLabel} />
}
