interface ProgressBarProps {
  value: number; // 0-100
  label?: string;
  showValue?: boolean;
}

function colorClass(value: number): string {
  if (value >= 100) return 'bg-green-500';
  if (value >= 60) return 'bg-blue-500';
  if (value >= 30) return 'bg-yellow-500';
  return 'bg-orange-400';
}

export function ProgressBar({ value, label, showValue = true }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className="w-full">
      {(label || showValue) && (
        <div className="flex justify-between items-center mb-1.5 text-sm text-gray-600">
          {label && <span>{label}</span>}
          {showValue && <span className="font-medium">{clamped}%</span>}
        </div>
      )}
      <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${colorClass(clamped)}`}
          style={{ width: `${clamped}%` }}
          role="progressbar"
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}
