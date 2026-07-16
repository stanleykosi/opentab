'use client';

import { Button, CanonicalStatus, InlineAlert, ProgressTimeline } from '@opentab/ui';
import type { useBoundOperation } from './use-bound-operation';

type Controller = ReturnType<typeof useBoundOperation>;

export function BoundOperationStatus({
  confirmLabel,
  controller,
  noun,
}: {
  confirmLabel: string;
  controller: Controller;
  noun: string;
}) {
  if (controller.state === 'idle') return null;

  if (controller.state === 'review' && controller.preview !== undefined) {
    return (
      <section aria-label={`${noun} approval`} className="operation-approval">
        <InlineAlert title="Review exact approval" tone="warning">
          <p>
            OpenTab verified the server-bound destination and calls. Your embedded account will
            approve only this operation.
          </p>
        </InlineAlert>
        <dl className="payment-ledger">
          <div>
            <dt>Estimated payment cost</dt>
            <dd>${controller.preview.estimatedFeeUsd}</dd>
          </div>
          <div className="payment-ledger__total">
            <dt>Maximum total</dt>
            <dd>${controller.preview.maximumTotalUsd}</dd>
          </div>
        </dl>
        <div className="page-actions">
          <Button onClick={() => void controller.submit()} size="large">
            {confirmLabel}
          </Button>
          <Button onClick={controller.reset} variant="quiet">
            Cancel review
          </Button>
        </div>
      </section>
    );
  }

  if (controller.state === 'confirmed') {
    return (
      <section className="operation-approval">
        <CanonicalStatus label="Canonically confirmed" tone="confirmed" />
        <h2>{noun} confirmed</h2>
        <p>The indexed canonical contract event is now the authoritative record.</p>
      </section>
    );
  }

  if (['preparing', 'submitting', 'submitted_unknown', 'confirming'].includes(controller.state)) {
    const uncertain = controller.state === 'submitted_unknown';
    return (
      <section aria-live="polite" className="operation-approval">
        <h2>
          {controller.state === 'preparing'
            ? `Preparing ${noun.toLowerCase()}`
            : controller.state === 'submitting'
              ? `Submitting ${noun.toLowerCase()}`
              : `Confirming ${noun.toLowerCase()}`}
        </h2>
        {uncertain ? (
          <InlineAlert title="Do not approve this again" tone="warning">
            <p>
              The operation may have moved. Its durable provider reference is saved while OpenTab
              reconciles canonical settlement.
            </p>
          </InlineAlert>
        ) : null}
        <ProgressTimeline
          label={`${noun} progress`}
          items={[
            {
              id: 'preview',
              label: 'Exact calls verified',
              status: controller.state === 'preparing' ? 'current' : 'complete',
            },
            {
              id: 'submit',
              label: 'Operation submitted',
              status:
                controller.state === 'submitting'
                  ? 'current'
                  : controller.state === 'preparing'
                    ? 'upcoming'
                    : 'complete',
            },
            {
              id: 'canonical',
              label: 'Canonical event confirmed',
              status: uncertain
                ? 'attention'
                : controller.state === 'confirming'
                  ? 'current'
                  : 'upcoming',
            },
          ]}
        />
        {controller.state === 'confirming' || uncertain ? (
          <Button onClick={() => void controller.check()} variant="secondary">
            Check canonical status
          </Button>
        ) : null}
      </section>
    );
  }

  return controller.error === undefined ? null : (
    <InlineAlert title={`${noun} was not confirmed`} tone="danger">
      <p>{controller.error}</p>
    </InlineAlert>
  );
}
