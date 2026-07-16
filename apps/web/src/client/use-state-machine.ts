'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ActorRef, MachineSnapshot, StateMachine } from './xstate-runtime.js';
import { createActor } from './xstate-runtime.js';

export function useStateMachine<TContext, TEvent, TInput>(
  machine: StateMachine<TContext, TEvent, TInput>,
  input: TInput,
): readonly [MachineSnapshot<TContext>, (event: TEvent) => void] {
  const [actor] = useState<ActorRef<TContext, TEvent>>(() => createActor(machine, { input }));
  const [snapshot, setSnapshot] = useState<MachineSnapshot<TContext>>(() => actor.getSnapshot());

  useEffect(() => {
    const subscription = actor.subscribe(setSnapshot);
    actor.start();
    setSnapshot(actor.getSnapshot());
    return () => subscription.unsubscribe();
  }, [actor]);

  const send = useCallback((event: TEvent) => actor.send(event), [actor]);
  return [snapshot, send] as const;
}
