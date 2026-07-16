export interface ProgressMeterProps {
  label: string;
  current: string;
  target: string;
  detail?: string;
}

export function ProgressMeter({ current, detail, label, target }: ProgressMeterProps) {
  const currentValue = BigInt(current);
  const targetValue = BigInt(target);
  const clamped = targetValue === 0n ? 0n : currentValue > targetValue ? targetValue : currentValue;
  const percent = targetValue === 0n ? '0' : ((clamped * 100n) / targetValue).toString();
  return (
    <div className="ot-progress">
      <div className="ot-progress__label">
        <strong>{label}</strong>
        <span>
          {current} of {target}
        </span>
      </div>
      <div
        aria-label={`${label}: ${current} of ${target}`}
        aria-valuemax={
          targetValue > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(targetValue)
        }
        aria-valuemin={0}
        aria-valuenow={
          currentValue > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(currentValue)
        }
        className="ot-progress__track"
        role="progressbar"
      >
        <span style={{ inlineSize: `${percent}%` }} />
      </div>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}
