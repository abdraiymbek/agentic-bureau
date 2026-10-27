import React, { useState } from 'react';
import { ArrowRight, ChartLine } from '../ui/icons';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { ChatPart } from '@bureau/contracts';
import { Segmented } from '../ui/kit';
export default function ChartCard({ part }: { part: Extract<ChatPart, { kind: 'chart' }> }) {
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const [selected, setSelected] = useState(0);
  const x = `${part.xLabel}${part.xUnit ? ` (${part.xUnit})` : ''}`;
  const y = `${part.yLabel}${part.yUnit ? ` (${part.yUnit})` : ''}`;
  const point = part.points[selected]!;
  return (
    <section className="inline-card inline-chart">
      <header className="inline-card-head">
        <span className="inline-card-icon">
          <ChartLine size={19} />
        </span>
        <div>
          <span className="chat-eyebrow">Illustrative · agent-authored · unverified</span>
          <h2>{part.title}</h2>
        </div>
        <Segmented
          label="Chart display"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </header>
      {mode === 'chart' ? (
        <>
          <div
            className="inline-chart-canvas"
            role="group"
            aria-label={`${x} versus ${y}. Arrow keys inspect data points.`}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                setSelected((v) =>
                  Math.min(
                    part.points.length - 1,
                    Math.max(0, v + (e.key === 'ArrowRight' ? 1 : -1)),
                  ),
                );
              }
            }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={part.points}
                margin={{ top: 12, right: 24, bottom: 24, left: 8 }}
                accessibilityLayer
              >
                <CartesianGrid stroke="var(--line-strong)" vertical={false} />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  stroke="var(--text-3)"
                  label={{ value: x, position: 'bottom', fill: 'var(--text-2)' }}
                />
                <YAxis
                  stroke="var(--text-3)"
                  label={{ value: y, angle: -90, position: 'insideLeft', fill: 'var(--text-2)' }}
                  width={65}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--raised)',
                    border: '1px solid var(--line-strong)',
                    borderRadius: 'var(--r-sm)',
                    color: 'var(--text)',
                  }}
                  labelFormatter={(v) => `${part.xLabel}: ${v} ${part.xUnit}`}
                  formatter={(v) => [`${v} ${part.yUnit}`, part.yLabel]}
                />
                <Legend verticalAlign="top" />
                <Line
                  dataKey="y"
                  name={part.yLabel}
                  stroke="var(--text-2)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="inline-chart-readout num" aria-live="polite">
            {part.xLabel}: {point.x} {part.xUnit} <ArrowRight size={12} /> {part.yLabel}: {point.y}{' '}
            {part.yUnit}
            <span>
              ← → inspect · {selected + 1} of {part.points.length}
            </span>
          </p>
        </>
      ) : (
        <div className="inline-table-wrap">
          <table className="inline-table">
            <caption>{part.title} · illustrative values</caption>
            <thead>
              <tr>
                <th>{x}</th>
                <th>{y}</th>
              </tr>
            </thead>
            <tbody>
              {part.points.map((p, i) => (
                <tr key={i}>
                  <td>{p.x}</td>
                  <td>{p.y}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="inline-caption">
        Source: {part.source}. This chart is an explanation, not recorded verification.
      </p>
    </section>
  );
}
