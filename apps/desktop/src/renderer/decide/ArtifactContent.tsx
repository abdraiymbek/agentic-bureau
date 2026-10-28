/**
 * The complete content of a proposed revision, read-only, in the shape its stage gives it: a
 * requirement as a statement with a target, a calculation as a result with its inputs, wiring
 * as pins and connections. Shown for new objects, and on request for any change.
 */
import React, { useMemo } from 'react';
import type {
  AssemblyPayload,
  AssumptionPayload,
  CalculationPayload,
  ComponentPayload,
  ConceptPayload,
  RequirementPayload,
  SoftwarePayload,
  SourcePayload,
  TestPayload,
  WiringPayload,
} from '@bureau/contracts';
import { describe, flatten, quantityText } from '../lib/diff';
import { State } from '../ui/kit';
import { ExternalLink } from '../ui/ExternalLink';
import { errMsg } from '../api';
import { useStore } from '../store';
import { linkDestination, safeMarkdown, safeSvg } from '../lib/markdown';
import { LocalTime, RefTitle, ShownValue } from './parts';
import { describeAssertions } from '../lib/spec-format';

type ArchitecturePayload = { markdown?: string; diagramSvg?: string };

const Missing = () => <span className="review-empty">Not recorded</span>;
const text = (v?: string | null) => (v?.trim() ? v : <Missing />);
const qty = (v: unknown) => (v === undefined ? <Missing /> : <ShownValue value={describe(v)} />);

function Rows({ rows }: { rows: [string, React.ReactNode | undefined][] }) {
  const shown = rows.filter(([, v]) => v !== undefined);
  if (!shown.length) return null;
  return (
    <dl className="review-facts">
      {shown.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function List({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <section className="review-block">
      <h4>{title}</h4>
      <ul className="plain-list">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="review-block">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** Opens a clicked web link in the system browser; the webview itself never follows a link. */
function openLink(e: React.MouseEvent) {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  const url = linkDestination(a.getAttribute('href'));
  if (url)
    void window.bureau
      .openExternal(url)
      .catch((error) => useStore.getState().toast('error', errMsg(error)));
}

/** Markdown as prose, sanitised by the shared rules (`lib/markdown.ts`). */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => safeMarkdown(source), [source]);
  return (
    <div
      className="decide-prose"
      onClick={openLink}
      onAuxClick={openLink}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Svg({ source }: { source: string }) {
  const html = useMemo(() => safeSvg(source), [source]);
  return (
    <div
      className="review-svg"
      onClick={openLink}
      onAuxClick={openLink}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const PRIORITY: Record<string, string> = { must: 'Must', should: 'Should', could: 'Could' };

/**
 * What a linked part must show, read-only: each feature with its value and the cad_check
 * assertions recorded for it. Approving the requirement approves these too.
 */
function Features({ features }: { features: NonNullable<RequirementPayload['features']> }) {
  return (
    <Block title="Features a linked part must show">
      <ul className="requirement-features">
        {features.map((feature, i) => {
          const assertions = describeAssertions(feature.expect);
          return (
            <li key={i}>
              <strong>{feature.label}</strong>
              {feature.quantity !== undefined && <ShownValue value={describe(feature.quantity)} />}
              {assertions.length ? (
                <ul className="requirement-feature-assertions mono">
                  {assertions.map((line, j) => (
                    <li key={j}>{line}</li>
                  ))}
                </ul>
              ) : (
                <span className="review-muted">
                  No assertions recorded; a check of a linked part has to give its own.
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function Requirement({ p }: { p: RequirementPayload }) {
  return (
    <>
      <p className="review-statement">{text(p.statement)}</p>
      <Rows
        rows={[
          ['Target', qty(p.target)],
          ['Priority', PRIORITY[p.priority] ?? p.priority],
          ['Acceptance', text(p.acceptanceCriterion)],
          ['Verification', p.verification ? p.verification : undefined],
          ['Source', p.sourceId ? <RefTitle id={p.sourceId} /> : undefined],
        ]}
      />
      {!!p.features?.length && <Features features={p.features} />}
    </>
  );
}

function Assumption({ p }: { p: AssumptionPayload }) {
  return (
    <>
      <p className="review-caution">An assumption is not an established fact.</p>
      <p className="review-statement">{text(p.statement)}</p>
      <Rows
        rows={[
          ['Value', p.value === undefined ? undefined : qty(p.value)],
          ['Reason', text(p.reason)],
          ['Uncertainty', p.uncertainty ? p.uncertainty : undefined],
          ['Owner', text(p.owner)],
          ['Needs validation', p.needsValidation === false ? 'No' : 'Yes'],
        ]}
      />
    </>
  );
}

function Component({ p }: { p: ComponentPayload }) {
  const properties = Object.entries(p.properties ?? {});
  const attributes = Object.entries(p.attributes ?? {});
  return (
    <>
      <p className="review-headline">
        <span className="mono">{p.partNumber || 'No part number'}</span>
        {(p.manufacturer || p.vendor) && <span> · {p.manufacturer ?? p.vendor}</span>}
      </p>
      <Rows
        rows={[
          ['Manufacturer', p.manufacturer ? p.manufacturer : undefined],
          ['Vendor', p.vendor ? p.vendor : undefined],
          ['Status', <State key="s" state={p.status ?? 'candidate'} quiet />],
          ['Description', p.description ? p.description : undefined],
          ['Selection reason', text(p.selectionReason)],
          ['Image', p.imageUrl ? <ExternalLink url={p.imageUrl} /> : undefined],
        ]}
      />
      <Block title="Properties">
        {properties.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Value</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {properties.map(([name, v]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{qty(v.quantity)}</td>
                    <td>
                      {v.sourceId ? <RefTitle id={v.sourceId} /> : <Missing />}
                      {v.locator && <span className="cell-sub">{v.locator}</span>}
                      {v.observedAt && (
                        <span className="cell-sub">
                          observed <LocalTime iso={v.observedAt} />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="review-muted">No properties recorded.</p>
        )}
      </Block>
      {attributes.length > 0 && (
        <Block title="Attributes">
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {attributes.map(([name, v]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{v.value}</td>
                    <td>{v.sourceId ? <RefTitle id={v.sourceId} /> : <Missing />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}
      <List title="Missing fields" items={p.missingFields} />
    </>
  );
}

function Source({ p }: { p: SourcePayload }) {
  return (
    <>
      {p.excerpt ? <blockquote className="review-quote">{p.excerpt}</blockquote> : null}
      <Rows
        rows={[
          ['Title', text(p.title)],
          ['Publisher', p.publisher ? p.publisher : undefined],
          [
            'Kind',
            `${p.kind === 'url' ? 'Web page' : 'File'} · ${(p.sourceKind ?? 'other').replaceAll('_', ' ')}`,
          ],
          ['Retrieved', p.retrievedAt ? <LocalTime iso={p.retrievedAt} /> : <Missing />],
          ['Link', p.kind === 'url' ? <ExternalLink url={p.url} /> : undefined],
          ['Locator', p.locator ? p.locator : undefined],
          ['File hash', p.fileHash ? <span className="mono">{p.fileHash}</span> : undefined],
        ]}
      />
    </>
  );
}

function Calculation({ p }: { p: CalculationPayload }) {
  const result = p.result?.quantity;
  return (
    <>
      <p className="review-result mono">
        {result ? (
          <ShownValue value={describe(result)} />
        ) : p.result?.text ? (
          p.result.text
        ) : (
          'Not run'
        )}
      </p>
      {result && p.result?.text && <p className="review-muted">{p.result.text}</p>}
      {p.expression && <pre className="code-block">{p.expression}</pre>}
      <Block title="Inputs">
        {p.inputs?.length ? (
          <ul className="review-inputs">
            {p.inputs.map((input, i) => (
              <li key={i}>
                <span className="mono">{input.name}</span> = {qty(input.quantity)}
                <span className="dim">
                  {' · '}
                  {input.sourceRef ? (
                    <RefTitle id={input.sourceRef.artifactId} />
                  ) : input.literal ? (
                    'literal'
                  ) : (
                    'no source recorded'
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="review-muted">No inputs recorded.</p>
        )}
      </Block>
      <List title="Assumptions" items={p.assumptions} />
      <List title="Limitations" items={p.limitations} />
      <Rows
        rows={[
          ['Evidence', (p.evidenceKind ?? 'calculated').replaceAll('_', ' ')],
          ['Template', p.templateId ? <span className="mono">{p.templateId}</span> : undefined],
          ['Engine', p.toolVersion ? <span className="mono">{p.toolVersion}</span> : undefined],
          ['Ran', p.ranAt ? <LocalTime iso={p.ranAt} /> : undefined],
        ]}
      />
    </>
  );
}

function Test({ p }: { p: TestPayload }) {
  return (
    <>
      <Block title="Procedure">
        {p.procedure?.length ? (
          <ol className="review-steps">
            {p.procedure.map((s, i) => (
              <li key={i}>
                <span>{s.instruction}</span>
                {s.expected && <span className="cell-sub">Expected: {s.expected}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="review-muted">No procedure recorded.</p>
        )}
      </Block>
      <Rows rows={[['Conditions', p.conditions ? p.conditions : undefined]]} />
      <Block title="Results">
        {p.results?.length ? (
          <ul className="review-results">
            {p.results.map((r) => (
              <li key={r.id}>
                <State state={r.result} />
                <span>{r.observation}</span>
                <span className="cell-sub">
                  {r.evidenceKind} · {r.recordedBy} · <LocalTime iso={r.recordedAt} />
                  {r.conditions ? ` · ${r.conditions}` : ''}
                  {r.measurementOrigin ? ` · from ${r.measurementOrigin}` : ''}
                </span>
                {r.attachments?.length > 0 && (
                  <span className="cell-sub mono">
                    {r.attachments.map((a) => a.path).join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="review-muted">Not run yet. A plan is not evidence.</p>
        )}
      </Block>
    </>
  );
}

function Wiring({ p }: { p: WiringPayload }) {
  return (
    <>
      <Block title="Pins">
        {p.pins?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Pin</th>
                  <th>Type</th>
                  <th>Voltage range</th>
                </tr>
              </thead>
              <tbody>
                {p.pins.map((pin, i) => (
                  <tr key={i}>
                    <td>
                      <RefTitle id={pin.componentArtifactId} />
                    </td>
                    <td className="mono">
                      {pin.pin}
                      {pin.name && <span className="cell-sub">{pin.name}</span>}
                    </td>
                    <td>{pin.type}</td>
                    <td className="review-qty">
                      {pin.voltageRange
                        ? `${quantityText(pin.voltageRange.min)} – ${quantityText(pin.voltageRange.max)}`
                        : 'Not recorded'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="review-muted">No pins recorded.</p>
        )}
      </Block>
      <Block title="Connections">
        {p.connections?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Carries</th>
                  <th>Wire</th>
                </tr>
              </thead>
              <tbody>
                {p.connections.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <RefTitle id={c.from.componentArtifactId} />{' '}
                      <span className="mono">{c.from.pin}</span>
                    </td>
                    <td>
                      <RefTitle id={c.to.componentArtifactId} />{' '}
                      <span className="mono">{c.to.pin}</span>
                    </td>
                    <td>
                      {c.signalRole}
                      {c.voltage && (
                        <span className="cell-sub review-qty">{quantityText(c.voltage)}</span>
                      )}
                      {c.polarity && <span className="cell-sub">polarity {c.polarity}</span>}
                    </td>
                    <td>
                      {c.wire?.gauge ?? <Missing />}
                      {c.wire?.currentRating && (
                        <span className="cell-sub review-qty">
                          {quantityText(c.wire.currentRating)}
                        </span>
                      )}
                      {c.notes && <span className="cell-sub">{c.notes}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="review-muted">No connections recorded.</p>
        )}
      </Block>
      <Rows rows={[['Coverage', p.coverageNote ? p.coverageNote : undefined]]} />
    </>
  );
}

function Assembly({ p }: { p: AssemblyPayload }) {
  if (!p.steps?.length) return <p className="review-muted">No steps recorded.</p>;
  return (
    <ol className="review-steps">
      {p.steps.map((s, i) => (
        <li key={i}>
          <span>{s.instruction}</span>
          {s.tools?.length > 0 && <span className="cell-sub">Tools: {s.tools.join(', ')}</span>}
          {s.calibration && <span className="cell-sub">Calibration: {s.calibration}</span>}
          {s.componentRefs?.length > 0 && (
            <span className="review-refs">
              {s.componentRefs.map((id) => (
                <RefTitle key={id} id={id} />
              ))}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function Concept({ p }: { p: ConceptPayload }) {
  const dims = Object.entries(p.approxDimensions ?? {});
  return (
    <>
      <p className="review-prose">{text(p.description)}</p>
      <List title="Systems" items={p.systems} />
      {dims.length > 0 && (
        <Block title="Approximate dimensions">
          <Rows rows={dims.map(([k, v]) => [k, qty(v)])} />
        </Block>
      )}
      <List title="Alternatives" items={p.alternatives} />
      <List title="Uncertainties" items={p.uncertainties} />
      <Rows
        rows={[
          ['Visual', p.visualFile ? <span className="mono">{p.visualFile.path}</span> : undefined],
          ['Visual kind', p.visualKind ? p.visualKind.replaceAll('_', ' ') : undefined],
        ]}
      />
    </>
  );
}

function Software({ p }: { p: SoftwarePayload }) {
  return (
    <>
      <Rows
        rows={[
          ['Language', p.language ? p.language : undefined],
          ['Entry point', p.entryPoint ? <span className="mono">{p.entryPoint}</span> : undefined],
          ['Notes', p.notes ? p.notes : undefined],
        ]}
      />
      <List title="Files" items={p.files?.map((f) => f.path)} />
    </>
  );
}

function Generic({ payload }: { payload: unknown }) {
  const fields = flatten(payload);
  return <Rows rows={fields.map((f) => [f.label, <ShownValue key={f.label} value={f.value} />])} />;
}

/** Everything the revision records, in its type's shape. */
export function ArtifactContent({ type, payload }: { type: string; payload: unknown }) {
  const p = (payload ?? {}) as never;
  let body: React.ReactNode;
  switch (type) {
    case 'requirement':
      body = <Requirement p={p} />;
      break;
    case 'assumption':
      body = <Assumption p={p} />;
      break;
    case 'component':
      body = <Component p={p} />;
      break;
    case 'source':
      body = <Source p={p} />;
      break;
    case 'calculation':
      body = <Calculation p={p} />;
      break;
    case 'test':
      body = <Test p={p} />;
      break;
    case 'wiring':
      body = <Wiring p={p} />;
      break;
    case 'assembly':
      body = <Assembly p={p} />;
      break;
    case 'architecture':
      body = (
        <>
          <Markdown source={(p as ArchitecturePayload).markdown ?? ''} />
          {(p as ArchitecturePayload).diagramSvg && (
            <Svg source={(p as ArchitecturePayload).diagramSvg!} />
          )}
        </>
      );
      break;
    case 'note':
      body = <Markdown source={(p as { markdown?: string }).markdown ?? ''} />;
      break;
    case 'concept':
      body = <Concept p={p} />;
      break;
    case 'subsystem':
      body = <p className="review-prose">{text((p as { description?: string }).description)}</p>;
      break;
    case 'software':
      body = <Software p={p} />;
      break;
    default:
      body = <Generic payload={payload} />;
  }
  return <div className={`review-content review-content-${type}`}>{body}</div>;
}
