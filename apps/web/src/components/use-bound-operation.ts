'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BrowserApiError, ContractOperationRecord } from '../application/browser-api-client';
import {
  type BrowserApplicationService,
  getBrowserApplicationService,
} from '../application/browser-application-service';

export type BoundOperationState =
  | 'idle'
  | 'preparing'
  | 'review'
  | 'submitting'
  | 'submitted_unknown'
  | 'confirming'
  | 'confirmed'
  | 'failed';

export interface BoundOperationPreview {
  readonly operationId: string;
  readonly estimatedFeeUsd: string;
  readonly maximumTotalUsd: string;
  readonly expiresAt: string;
}

function stateFromRecord(operation: ContractOperationRecord): BoundOperationState {
  switch (operation.status) {
    case 'prepared':
      return 'idle';
    case 'submission_started':
    case 'submitted_unknown':
      return 'submitted_unknown';
    case 'submitted':
    case 'confirming':
      return 'confirming';
    case 'confirmed':
      return 'confirmed';
    case 'failed':
    case 'orphaned':
      return 'failed';
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'OpenTab could not verify this exact operation. Nothing new was submitted.';
}

/**
 * Shared browser state for server-bound contract operations. A canonical
 * `confirmed` operation is the only success state; provider acceptance remains
 * recoverable progress.
 */
export function useBoundOperation(providedService?: BrowserApplicationService) {
  const service = useMemo(
    () => providedService ?? getBrowserApplicationService(),
    [providedService],
  );
  const [state, setState] = useState<BoundOperationState>('idle');
  const [operation, setOperation] = useState<ContractOperationRecord>();
  const [preview, setPreview] = useState<BoundOperationPreview>();
  const [error, setError] = useState<string>();

  const adopt = useCallback((record: ContractOperationRecord) => {
    setOperation(record);
    setPreview(undefined);
    setError(undefined);
    setState(stateFromRecord(record));
  }, []);

  const prepare = useCallback(
    async (record: ContractOperationRecord) => {
      if (record.status !== 'prepared') {
        adopt(record);
        return undefined;
      }
      setOperation(record);
      setState('preparing');
      setError(undefined);
      try {
        const prepared = await service.prepareContractOperation(record);
        const next = {
          operationId: record.id,
          estimatedFeeUsd: prepared.plan.quote.estimatedFeeUsd,
          maximumTotalUsd: prepared.plan.quote.totalUsd,
          expiresAt: prepared.plan.expiresAt,
        } satisfies BoundOperationPreview;
        setPreview(next);
        setState('review');
        return next;
      } catch (caught) {
        setError(safeMessage(caught));
        setState('failed');
        throw caught;
      }
    },
    [adopt, service],
  );

  const submit = useCallback(async () => {
    if (operation === undefined || state !== 'review') return undefined;
    setState('submitting');
    setError(undefined);
    try {
      const result = await service.submitContractOperation(operation.id);
      setOperation(result.operation);
      setState(
        result.kind === 'submitted_unknown'
          ? 'submitted_unknown'
          : stateFromRecord(result.operation),
      );
      return result;
    } catch (caught) {
      const possible =
        typeof caught === 'object' &&
        caught !== null &&
        'submissionPossible' in caught &&
        (caught as BrowserApiError).submissionPossible === true;
      setError(safeMessage(caught));
      setState(possible ? 'submitted_unknown' : 'failed');
      throw caught;
    }
  }, [operation, service, state]);

  const check = useCallback(async () => {
    if (operation === undefined) return undefined;
    try {
      const current = await service.getContractOperation(operation.id);
      setOperation(current);
      setState(stateFromRecord(current));
      setError(undefined);
      return current;
    } catch (caught) {
      setError(safeMessage(caught));
      return undefined;
    }
  }, [operation, service]);

  useEffect(() => {
    if (!['confirming', 'submitted_unknown'].includes(state) || operation === undefined) return;
    const pollWhenVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const interval = window.setInterval(pollWhenVisible, 5_000);
    document.addEventListener('visibilitychange', pollWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', pollWhenVisible);
    };
  }, [check, operation, state]);

  const reset = useCallback(() => {
    setState('idle');
    setOperation(undefined);
    setPreview(undefined);
    setError(undefined);
  }, []);

  return { adopt, check, error, operation, prepare, preview, reset, state, submit } as const;
}
