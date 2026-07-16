import {
  CanonicalStatus,
  EvidenceRow,
  ExternalProofLink,
  InlineAlert,
  MoneyAmount,
  ProgressTimeline,
} from '@opentab/ui';
import type { JudgeClaimEvidence, JudgeProofView } from '../../client/view-models';

function provenance(proof: JudgeProofView) {
  switch (proof.provenance) {
    case 'live':
      return {
        label: 'LIVE',
        tone: 'confirmed' as const,
        body: 'Fresh public evidence from the configured live environment.',
      };
    case 'recorded_live':
      return {
        label: 'RECORDED LIVE',
        tone: 'attention' as const,
        body: 'Immutable evidence captured from a prior live run.',
      };
    case 'staging':
      return {
        label: 'STAGING',
        tone: 'processing' as const,
        body: 'Staging evidence. It is not mainnet sponsor proof.',
      };
    case 'deterministic':
      return {
        label: 'DETERMINISTIC DEMO',
        tone: 'neutral' as const,
        body: 'Synthetic, repeatable records for interface testing. No live funds moved.',
      };
  }
}

function claimPresentation(evidence: JudgeClaimEvidence, value: boolean) {
  if (evidence === 'deterministic_fixture') {
    return { label: 'Fixture only', tone: 'attention' as const };
  }
  if (evidence === 'not_evidenced') {
    return { label: 'Not evidenced', tone: 'attention' as const };
  }
  return value
    ? { label: 'Verified', tone: 'confirmed' as const }
    : { label: 'Failed', tone: 'failed' as const };
}

function IntegrityResult({
  label,
  value,
  evidence,
}: {
  label: string;
  value: boolean;
  evidence: JudgeClaimEvidence;
}) {
  const presentation = claimPresentation(evidence, value);
  return (
    <li>
      <CanonicalStatus label={presentation.label} tone={presentation.tone} />
      <span>{label}</span>
    </li>
  );
}

function explorerOrigin(chainId: string): string | undefined {
  if (chainId === '42161') return 'https://arbiscan.io';
  if (chainId === '421614') return 'https://sepolia.arbiscan.io';
  return undefined;
}

function explorerUrl(
  chainId: string,
  resource: 'address' | 'block' | 'token' | 'tx',
  value: string,
): string | undefined {
  const origin = explorerOrigin(chainId);
  return origin === undefined ? undefined : `${origin}/${resource}/${encodeURIComponent(value)}`;
}

function slippagePercent(basisPoints: string | undefined): string {
  if (basisPoints === undefined) return 'Not recorded';
  const value = BigInt(basisPoints);
  const whole = value / 100n;
  const fractional = (value % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fractional.length === 0 ? '' : `.${fractional}`}%`;
}

function duration(value: string | undefined): string {
  return value === undefined ? 'Not recorded' : `${BigInt(value).toLocaleString('en-US')} ms`;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function JudgeProof({ proof }: { proof: JudgeProofView }) {
  const source = provenance(proof);
  const continuity = claimPresentation(proof.account.continuityEvidence, proof.account.continuous);
  const eip7702 = claimPresentation(proof.route.eip7702Evidence, proof.route.eip7702);
  const routeRecorded = Boolean(
    proof.route.operationId ??
      proof.route.previewDigest ??
      proof.route.totalUsd ??
      proof.route.sources?.length,
  );
  const routeEvidence = claimPresentation(proof.route.routeEvidence, routeRecorded);
  const event = proof.settlement.event;
  const eventConfirmed = Boolean(
    event?.canonical &&
      event.chainId === proof.settlement.chainId &&
      sameAddress(event.contractAddress, proof.settlement.checkoutAddress) &&
      sameAddress(event.fields.token, proof.settlement.tokenAddress) &&
      event.fields.amountBaseUnits === proof.settlement.amountBaseUnits &&
      event.fields.passTokenId === proof.settlement.passTokenId,
  );
  const delegationExplorer =
    proof.account.delegationTransaction === undefined
      ? undefined
      : explorerUrl(proof.settlement.chainId, 'tx', proof.account.delegationTransaction);
  const checkoutExplorer = explorerUrl(
    proof.settlement.chainId,
    'address',
    proof.settlement.checkoutAddress,
  );
  const passExplorer = explorerUrl(
    proof.settlement.chainId,
    'address',
    proof.settlement.passAddress,
  );
  const tokenExplorer = explorerUrl(
    proof.settlement.chainId,
    'token',
    proof.settlement.tokenAddress,
  );
  const eventTransactionExplorer =
    event === undefined
      ? undefined
      : explorerUrl(proof.settlement.chainId, 'tx', event.transactionHash);
  const eventBlockExplorer =
    event === undefined
      ? undefined
      : explorerUrl(proof.settlement.chainId, 'block', event.blockNumber);
  const eventContractExplorer =
    event === undefined
      ? undefined
      : explorerUrl(proof.settlement.chainId, 'address', event.contractAddress);
  return (
    <div className="judge-layout">
      <aside className="judge-nav">
        <a className="brand brand--judge" href="/">
          <span>OpenTab</span>
          <small>Judge Mode</small>
        </a>
        <nav aria-label="Evidence sections">
          <a href="#account">Account continuity</a>
          <a href="#route">Unified route</a>
          <a href="#settlement">Canonical settlement</a>
          <a href="#integrity">Integrity</a>
          <a href="#criteria">Criteria map</a>
        </nav>
        <p>All values are public-safe and server-generated.</p>
      </aside>
      <main className="judge-main" id="main-content">
        <header className="evidence-header">
          <div>
            <CanonicalStatus label={source.label} tone={source.tone} />
            <p className="eyebrow">Evidence {proof.evidenceId}</p>
            <h1>One account. One routed balance. One canonical order.</h1>
            <p>{source.body}</p>
          </div>
          <dl>
            <div>
              <dt>Order</dt>
              <dd className="mono">{proof.orderId}</dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>{proof.environment}</dd>
            </div>
            <div>
              <dt>Captured</dt>
              <dd>{proof.capturedAt}</dd>
            </div>
            <div>
              <dt>Refreshed</dt>
              <dd>{proof.refreshedAt}</dd>
            </div>
          </dl>
        </header>
        {proof.provenance === 'deterministic' ? (
          <InlineAlert title="This is not live payment proof" tone="warning">
            <p>
              Every identifier below is a sanitized deterministic fixture. Use it to review product
              behavior and proof layout only.
            </p>
          </InlineAlert>
        ) : null}
        <section className="proof-section" id="account">
          <div className="proof-section__intro">
            <p className="eyebrow">Proof 01</p>
            <h2>Magic account continuity</h2>
            <p>
              The embedded EOA remains the Particle owner before and after the EIP-7702 upgrade.
            </p>
          </div>
          <div className="proof-card">
            <CanonicalStatus
              label={
                proof.account.continuityEvidence === 'evidenced' && proof.account.continuous
                  ? 'Address unchanged'
                  : continuity.label
              }
              tone={continuity.tone}
            />
            <dl>
              <EvidenceRow label="Auth category" value={proof.account.authMethod} />
              <EvidenceRow
                copyLabel="Copy owner before"
                label="EOA before"
                mono
                value={proof.account.before}
              />
              <EvidenceRow
                copyLabel="Copy owner after"
                label="EOA after"
                mono
                value={proof.account.after}
              />
              <EvidenceRow
                label="Equality"
                value={
                  proof.account.continuous
                    ? proof.account.continuityEvidence === 'evidenced'
                      ? 'Exact address match'
                      : 'Same fixture value; continuity not independently evidenced'
                    : 'Continuity unavailable'
                }
              />
              <EvidenceRow label="Delegation" value={proof.account.delegationStatus} />
              {proof.account.delegationTarget ? (
                <EvidenceRow
                  copyLabel="Copy delegation target"
                  label="Delegation target"
                  mono
                  value={proof.account.delegationTarget}
                />
              ) : null}
              {proof.account.delegationTransaction ? (
                <EvidenceRow
                  label="Delegation transaction"
                  mono
                  value={proof.account.delegationTransaction}
                  trailing={
                    delegationExplorer === undefined ? null : (
                      <ExternalProofLink href={delegationExplorer} label="Open transaction" />
                    )
                  }
                />
              ) : null}
            </dl>
          </div>
        </section>
        <section className="proof-section" id="route">
          <div className="proof-section__intro">
            <p className="eyebrow">Proof 02</p>
            <h2>Particle EIP-7702 route</h2>
            <p>The route expects exact USDC on Arbitrum while sourcing a unified balance.</p>
          </div>
          <div className="proof-card">
            <CanonicalStatus
              label={
                proof.route.eip7702Evidence === 'evidenced' && proof.route.eip7702
                  ? 'EIP-7702 mode verified'
                  : eip7702.label
              }
              tone={eip7702.tone}
            />
            <dl>
              <EvidenceRow label="Route evidence" value={routeEvidence.label} />
              <EvidenceRow label="Owner / UA account" mono value={proof.route.accountAddress} />
              <EvidenceRow
                label="Unified balance before"
                value={
                  proof.route.totalUsd === undefined ? 'Not recorded' : `$${proof.route.totalUsd}`
                }
              />
              <EvidenceRow
                label="Estimated fee"
                value={
                  proof.route.estimatedFeeUsd === undefined
                    ? 'Not recorded'
                    : `$${proof.route.estimatedFeeUsd}`
                }
              />
              <EvidenceRow
                label="Maximum slippage"
                value={slippagePercent(proof.route.slippageBps)}
              />
              <EvidenceRow
                label="Quote observed"
                value={proof.route.quoteObservedAt ?? 'Not recorded'}
              />
              <EvidenceRow
                label="Validated preview digest"
                mono={proof.route.previewDigest !== undefined}
                value={proof.route.previewDigest ?? 'Not recorded'}
              />
              {proof.route.operationId ? (
                <EvidenceRow
                  copyLabel="Copy Particle ID"
                  label="Particle operation"
                  mono
                  value={proof.route.operationId}
                />
              ) : (
                <EvidenceRow label="Particle operation" value="Unavailable" />
              )}
              {proof.route.activityUrl === undefined ? (
                <EvidenceRow label="Particle activity" value="Not recorded" />
              ) : (
                <EvidenceRow
                  label="Particle activity"
                  mono
                  value={proof.route.activityUrl}
                  trailing={
                    <ExternalProofLink
                      href={proof.route.activityUrl}
                      label="Open Particle activity"
                    />
                  }
                />
              )}
            </dl>
            {proof.route.sources === undefined || proof.route.sources.length === 0 ? (
              <InlineAlert title="Source assets not recorded" tone="info">
                <p>This public proof does not claim a source-chain breakdown.</p>
              </InlineAlert>
            ) : (
              <>
                <h3>Sanitized source summary</h3>
                <table className="proof-table">
                  <caption className="sr-only">Source assets used by the route</caption>
                  <thead>
                    <tr>
                      <th scope="col">Chain</th>
                      <th scope="col">Asset</th>
                      <th scope="col">Amount</th>
                      <th scope="col">USD value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proof.route.sources.map((sourceItem) => (
                      <tr key={sourceItem.id}>
                        <td>{sourceItem.chainId}</td>
                        <td>{sourceItem.symbol}</td>
                        <td>{sourceItem.amount}</td>
                        <td>${sourceItem.amountUsd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </section>
        <section className="proof-section" id="settlement">
          <div className="proof-section__intro">
            <p className="eyebrow">Proof 03</p>
            <h2>Canonical Arbitrum settlement</h2>
            <p>
              Paid status requires a correctly decoded, canonical OrderPaid event bound to this
              chain, checkout, token, amount, and pass.
            </p>
          </div>
          <div className="proof-card">
            <CanonicalStatus
              label={
                eventConfirmed
                  ? 'Canonical OrderPaid binding verified'
                  : event === undefined
                    ? 'Expected OrderPaid event not present'
                    : 'OrderPaid binding mismatch'
              }
              tone={eventConfirmed ? 'confirmed' : event === undefined ? 'attention' : 'failed'}
            />
            <dl>
              <EvidenceRow
                copyLabel="Copy order ID"
                label="OpenTab order ID"
                mono
                value={proof.orderId}
              />
              <EvidenceRow label="Chain ID" value={proof.settlement.chainId} />
              <EvidenceRow
                copyLabel="Copy checkout address"
                label="Checkout contract"
                mono
                value={proof.settlement.checkoutAddress}
                trailing={
                  checkoutExplorer === undefined ? null : (
                    <ExternalProofLink href={checkoutExplorer} label="Open checkout contract" />
                  )
                }
              />
              <EvidenceRow
                copyLabel="Copy pass address"
                label="Pass contract"
                mono
                value={proof.settlement.passAddress}
                trailing={
                  passExplorer === undefined ? null : (
                    <ExternalProofLink href={passExplorer} label="Open pass contract" />
                  )
                }
              />
              <EvidenceRow
                copyLabel="Copy USDC address"
                label="Native USDC"
                mono
                value={proof.settlement.tokenAddress}
                trailing={
                  tokenExplorer === undefined ? null : (
                    <ExternalProofLink href={tokenExplorer} label="Open settlement token" />
                  )
                }
              />
              <EvidenceRow
                label="Exact amount"
                value=""
                trailing={<MoneyAmount baseUnits={proof.settlement.amountBaseUnits} />}
              />
              <EvidenceRow
                copyLabel="Copy receipt ID"
                label="Receipt ID"
                mono
                value={proof.settlement.receiptId}
              />
              <EvidenceRow label="Pass token ID" mono value={proof.settlement.passTokenId} />
              <EvidenceRow
                label="Observed decoded event"
                mono
                value={proof.settlement.observedEventName}
              />
              {event ? (
                <>
                  <EvidenceRow
                    label="Canonical"
                    value={event.canonical ? 'Yes' : 'No — paid is not proven'}
                  />
                  <EvidenceRow label="Confirmations observed" value={event.confirmations} />
                  <EvidenceRow label="Event chain ID" value={event.chainId} />
                  <EvidenceRow
                    copyLabel="Copy event contract"
                    label="Event contract"
                    mono
                    value={event.contractAddress}
                    trailing={
                      eventContractExplorer === undefined ? null : (
                        <ExternalProofLink
                          href={eventContractExplorer}
                          label="Open event contract"
                        />
                      )
                    }
                  />
                  <EvidenceRow
                    label="Block"
                    mono
                    value={event.blockNumber}
                    trailing={
                      eventBlockExplorer === undefined ? null : (
                        <ExternalProofLink href={eventBlockExplorer} label="Open block" />
                      )
                    }
                  />
                  <EvidenceRow label="Block hash" mono value={event.blockHash} />
                  <EvidenceRow label="Log index" mono value={event.logIndex} />
                  <EvidenceRow
                    label="Transaction"
                    mono
                    value={event.transactionHash}
                    trailing={
                      eventTransactionExplorer === undefined ? null : (
                        <ExternalProofLink
                          href={eventTransactionExplorer}
                          label="Open settlement transaction"
                        />
                      )
                    }
                  />
                  <EvidenceRow label="Event observed" value={event.observedAt} />
                  <EvidenceRow
                    copyLabel="Copy order key"
                    label="Decoded order key"
                    mono
                    value={event.fields.orderKey}
                  />
                  <EvidenceRow
                    label="Decoded merchant ID"
                    mono
                    value={event.fields.merchantOnchainId}
                  />
                  <EvidenceRow
                    label="Decoded product ID"
                    mono
                    value={event.fields.productOnchainId}
                  />
                  <EvidenceRow
                    copyLabel="Copy decoded payer"
                    label="Decoded payer"
                    mono
                    value={event.fields.payer}
                  />
                  <EvidenceRow
                    copyLabel="Copy decoded recipient"
                    label="Decoded recipient"
                    mono
                    value={event.fields.recipient}
                  />
                  <EvidenceRow
                    copyLabel="Copy decoded token"
                    label="Decoded token"
                    mono
                    value={event.fields.token}
                  />
                  <EvidenceRow label="Decoded quantity" value={event.fields.quantity} />
                  <EvidenceRow
                    label="Decoded amount"
                    value=""
                    trailing={<MoneyAmount baseUnits={event.fields.amountBaseUnits} />}
                  />
                  <EvidenceRow
                    label="Decoded platform fee"
                    value=""
                    trailing={<MoneyAmount baseUnits={event.fields.platformFeeBaseUnits} />}
                  />
                  <EvidenceRow
                    label="Decoded pass token ID"
                    mono
                    value={event.fields.passTokenId}
                  />
                  <EvidenceRow
                    label="Decoded refund deadline"
                    mono
                    value={event.fields.refundDeadline}
                  />
                  <EvidenceRow
                    copyLabel="Copy intent digest"
                    label="Decoded intent digest"
                    mono
                    value={event.fields.intentDigest}
                  />
                </>
              ) : (
                <EvidenceRow label="OrderPaid fields" value="Unavailable — paid is not proven" />
              )}
            </dl>
          </div>
        </section>
        <section className="proof-section" id="integrity">
          <div className="proof-section__intro">
            <p className="eyebrow">Proof 04</p>
            <h2>Recovery and binding integrity</h2>
            <p>These controls prevent browser interruption from creating a second payment.</p>
          </div>
          <div className="proof-card">
            <ul className="integrity-list">
              <IntegrityResult
                label="Provider ID persisted before waiting"
                value={proof.recovery.persistedBeforeWait}
                evidence={proof.recovery.persistenceEvidence}
              />
              <IntegrityResult
                label="Workflow recovered after reload"
                value={proof.recovery.reloadRecovered}
                evidence={proof.recovery.reloadEvidence}
              />
              <IntegrityResult
                label="Duplicate submission prevented"
                value={proof.recovery.duplicatePrevented}
                evidence={proof.recovery.duplicateEvidence}
              />
            </ul>
            <ProgressTimeline
              label="End-to-end proof timeline"
              items={[
                { id: 'identity', label: 'Magic identity established', status: 'complete' },
                {
                  id: 'delegation',
                  label: 'Same EOA delegated in place',
                  status:
                    proof.account.continuityEvidence === 'evidenced' && proof.account.continuous
                      ? 'complete'
                      : 'attention',
                },
                {
                  id: 'route',
                  label: 'Particle route submitted',
                  status:
                    proof.route.routeEvidence === 'evidenced' && proof.route.operationId
                      ? 'complete'
                      : 'attention',
                },
                {
                  id: 'event',
                  label: 'Canonical OrderPaid event',
                  status:
                    eventConfirmed && proof.provenance !== 'deterministic'
                      ? 'complete'
                      : 'attention',
                },
              ]}
            />
            <h3>Recorded timing phases</h3>
            <dl>
              <EvidenceRow
                label="Authentication"
                value={duration(proof.recovery.timing.authenticationMs)}
              />
              <EvidenceRow
                label="Delegation"
                value={duration(proof.recovery.timing.delegationMs)}
              />
              <EvidenceRow
                label="Route preparation"
                value={duration(proof.recovery.timing.routePreparationMs)}
              />
              <EvidenceRow
                label="Submission to canonical event"
                value={duration(proof.recovery.timing.submissionToCanonicalMs)}
              />
              <EvidenceRow
                label="Recovery verification"
                value={duration(proof.recovery.timing.recoveryVerificationMs)}
              />
              <EvidenceRow
                label="Total recorded duration"
                value={duration(proof.recovery.timing.totalDurationMs)}
              />
            </dl>
          </div>
        </section>
        <section className="criteria-map" id="criteria">
          <p className="eyebrow">Submission criteria</p>
          <h2>Evidence map</h2>
          <div>
            <a href="#account">
              <span>Magic embedded wallet</span>
              <strong>Account continuity</strong>
            </a>
            <a href="#route">
              <span>Particle Universal Accounts</span>
              <strong>EIP-7702 + unified sources</strong>
            </a>
            <a href="#settlement">
              <span>Arbitrum primary execution</span>
              <strong>OrderPaid + receipt/pass</strong>
            </a>
            <a href="#integrity">
              <span>Production quality</span>
              <strong>Binding, persistence, recovery</strong>
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
