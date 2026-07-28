interface ErrorMessageProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorMessage({ title = 'Error', message, onRetry }: ErrorMessageProps) {
  return (
    <div className="rounded-lg bg-red-50 border border-red-200 p-4" role="alert">
      <div className="flex items-start gap-3">
        <span className="text-red-500 text-lg leading-none" aria-hidden="true">⚠</span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-red-800 text-sm">{title}</p>
          <p className="text-red-700 text-sm mt-0.5">{message}</p>
        </div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 text-sm font-medium text-red-700 underline hover:no-underline focus:outline-none"
        >
          Retry
        </button>
      )}
    </div>
  );
}
