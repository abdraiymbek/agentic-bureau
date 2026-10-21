import React from 'react';
import type { VerificationReview } from '../decide/model';
import { Checkbox } from '../ui/kit';

const statusLabels: Record<string, string> = {
  passed: 'Passed declared checks',
  failed: 'Checks failed',
  partial: 'Partially checked',
  scope_changed: 'Check scope changed',
  unverified: 'Not verified for this revision',
};

/** The acceptance stays bound to the exact evidence hash in the owning review card. */
export function InlineVerification({
  verification,
  accepted,
  onAccept,
  disabled,
  showAcceptance = true,
}: {
  verification?: VerificationReview;
  accepted: boolean;
  onAccept: (accepted: boolean) => void;
  disabled?: boolean;
  showAcceptance?: boolean;
}) {
  const evidence = verification?.evidence;
  const checks = evidence?.checks ?? [];
  const passed = checks.filter((check) => check.pass).length;
  const results = checks
    .filter((check) => !check.pass)
    .concat(checks.filter((check) => check.pass));
  const scope = evidence?.coverage;
  const canAccept =
    !!verification?.evidenceHash &&
    verification.status !== 'unverified' &&
    evidence?.pass === true &&
    evidence.integrity?.pass === true;
  const renderChecks = (items: typeof checks) => (
    <ul className="inline-check-results">
      {items.map((check, index) => (
        <li key={`${check.name}-${index}`}>
          <span className={check.pass ? '' : 'tone-warn-text'}>
            {check.pass ? 'Passed' : 'Failed'}
          </span>
          <div>
            <strong>{check.name}</strong>
            <p>{check.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="inline-verification" aria-label="Recorded verification">
      <div className="inline-section-head">
        <strong>Recorded verification</strong>
        <span>
          {verification
            ? statusLabels[verification.status] || verification.status.replaceAll('_', ' ')
            : 'No engine verification recorded'}
        </span>
      </div>
      {checks.length ? (
        <p className="inline-check-summary">
          {passed} of {checks.length} recorded assertions passed
          {scope?.units ? ` · ${scope.units}` : ''}
          {scope?.frame ? ` · ${scope.frame.replaceAll('-', ' ')}` : ''}
        </p>
      ) : (
        <p>
          No recorded assertion results are available. Approval does not establish verification.
        </p>
      )}
      {!!scope?.assertions?.length && (
        <p className="inline-check-scope">
          <strong>Declared scope: </strong>
          {scope.assertions.join(' · ')}
        </p>
      )}
      {renderChecks(results.slice(0, 3))}
      {results.length > 3 && (
        <details className="inline-check-more">
          <summary>More assertion results · {results.length - 3}</summary>
          {renderChecks(results.slice(3))}
        </details>
      )}
      {evidence?.integrity && (
        <p className="inline-check-scope">
          Mesh integrity: {evidence.integrity.pass ? 'passed' : 'failed'}.{' '}
          {evidence.integrity.detail}
        </p>
      )}
      {!!evidence?.scopeChanges?.length && (
        <p className="tone-warn-text">Changed scope: {evidence.scopeChanges.join(' · ')}</p>
      )}
      {evidence?.exploratory && <p>This check is exploratory and does not bind the design.</p>}
      {canAccept && showAcceptance && (
        <div className="inline-scope-acceptance">
          <Checkbox
            label="Accept this exact declared verification scope with approval"
            checked={accepted}
            disabled={disabled}
            onChange={onAccept}
          />
          <p>Acceptance records your review of this scope; it does not certify the whole design.</p>
        </div>
      )}
      {!!scope?.limitations?.length && (
        <details className="inline-check-more">
          <summary>What these checks do not establish</summary>
          <ul>
            {scope.limitations.map((limitation, i) => (
              <li key={i}>{limitation}</li>
            ))}
          </ul>
        </details>
      )}
      {verification && (
        <details className="inline-check-more inline-technical-evidence">
          <summary>Technical evidence · exact scope, hashes & raw record</summary>
          <pre aria-label="Exact verification record">{JSON.stringify(verification, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
