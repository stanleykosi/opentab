import { MoneyAmount } from '@opentab/ui';
import type { Metadata } from 'next';
import { demoDashboard } from '../../../src/client/deterministic-data';
import { getServerFeatureState } from '../../../src/client/presentation-mode';
import { WithdrawalFlow } from '../../../src/components/merchant/finance-flows';
import { LiveBalancePage } from '../../../src/components/merchant/live-balance-page';
import { FeatureUnavailable, MerchantShell } from '../../../src/components/shell';

export const metadata: Metadata = {
  title: 'Merchant balance',
  robots: { index: false, follow: false },
};

export default function BalancePage() {
  const features = getServerFeatureState();
  return (
    <MerchantShell active="/merchant/balance" features={features}>
      {features.mode === 'live-unavailable' ? (
        <FeatureUnavailable
          body="Settlement balances require authenticated, confirmed records and fresh contract reads."
          title="Balance unavailable"
        />
      ) : features.mode === 'live' ? (
        <LiveBalancePage features={features} />
      ) : (
        <div className="merchant-content merchant-content--narrow">
          <header className="merchant-page-head">
            <div>
              <p className="eyebrow">Settlement balance</p>
              <h1>Available and protected</h1>
              <p>Confirmed proceeds remain separate from refundable and pending liabilities.</p>
            </div>
          </header>
          <section className="balance-equation">
            <div>
              <span>Settled gross</span>
              <MoneyAmount baseUnits={demoDashboard.grossBaseUnits} />
            </div>
            <i aria-hidden="true">−</i>
            <div>
              <span>Confirmed refunds</span>
              <MoneyAmount baseUnits={demoDashboard.refundedBaseUnits} />
            </div>
            <i aria-hidden="true">−</i>
            <div>
              <span>Pending and reserved</span>
              <MoneyAmount baseUnits={demoDashboard.pendingBaseUnits} />
            </div>
            <i aria-hidden="true">=</i>
            <div className="balance-equation__result">
              <span>Available now</span>
              <MoneyAmount baseUnits={demoDashboard.withdrawableBaseUnits} />
            </div>
            <p className="sr-only">
              Settled gross minus confirmed refunds and pending or reserved liabilities equals
              available balance.
            </p>
          </section>
          <WithdrawalFlow dashboard={demoDashboard} features={features} />
          <section className="order-ledger">
            <h2>Withdrawal history</h2>
            <p>No withdrawal is labeled complete until its settlement event is confirmed.</p>
            <dl className="summary-ledger">
              <div>
                <dt>Previously withdrawn</dt>
                <dd>
                  <MoneyAmount baseUnits={demoDashboard.withdrawnBaseUnits} />
                </dd>
              </div>
              <div>
                <dt>Most recent</dt>
                <dd>28 June · Confirmed</dd>
              </div>
            </dl>
          </section>
        </div>
      )}
    </MerchantShell>
  );
}
