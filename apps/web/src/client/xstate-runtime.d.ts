export interface MachineSnapshot<TContext> {
  readonly value: string | Readonly<Record<string, unknown>>;
  readonly context: TContext;
}

export interface StateMachine<TContext, TEvent, TInput> {
  readonly __opentabTypes?: {
    context: TContext;
    event: TEvent;
    input: TInput;
  };
}

export interface ActorRef<TContext, TEvent> {
  getSnapshot(): MachineSnapshot<TContext>;
  send(event: TEvent): void;
  start(): ActorRef<TContext, TEvent>;
  subscribe(observer: (snapshot: MachineSnapshot<TContext>) => void): { unsubscribe(): void };
}

type AssignmentValue<TContext, TEvent, Key extends keyof TContext> =
  | TContext[Key]
  | ((args: { context: TContext; event: TEvent }) => TContext[Key]);

export function assign<TContext extends object, TEvent>(
  assignment: { [Key in keyof TContext]?: AssignmentValue<TContext, TEvent, Key> },
): unknown;

export function setup<TContext, TEvent, TInput>(config: {
  types: { context: TContext; events: TEvent; input: TInput };
  guards?: Readonly<Record<string, (args: { context: TContext; event: TEvent }) => boolean>>;
  actions?: Readonly<Record<string, unknown>>;
}): {
  createMachine(config: unknown): StateMachine<TContext, TEvent, TInput>;
};

export function createActor<TContext, TEvent, TInput>(
  machine: StateMachine<TContext, TEvent, TInput>,
  options: { input: TInput },
): ActorRef<TContext, TEvent>;
