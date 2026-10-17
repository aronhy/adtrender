import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import './interactions.css';
type Props = {
  value?: string | null;
  label: string;
  successLabel: string;
  errorLabel: string;
  className?: string;
};
export function CopyButton({
  value,
  label,
  successLabel,
  errorLabel,
  className = 'text-button',
}: Props) {
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'failed'>(
    'idle'
  );
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setStatus('idle');
    return () => {
      generation.current++;
    };
  }, [value]);
  useEffect(() => {
    if (status !== 'done') return;
    const timer = window.setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <span className="ui-copy">
      <button
        type="button"
        className={`${className} ui-copy-button`}
        disabled={!value || status === 'pending'}
        aria-busy={status === 'pending'}
        onClick={async () => {
          if (!value || pending.current) return;
          pending.current = true;
          const version = generation.current;
          setStatus('pending');
          try {
            if (!navigator.clipboard?.writeText)
              throw Error('CLIPBOARD_UNAVAILABLE');
            await navigator.clipboard.writeText(value);
            if (version === generation.current) setStatus('done');
          } catch {
            if (version === generation.current) setStatus('failed');
          } finally {
            if (version === generation.current) pending.current = false;
          }
        }}
      >
        {status === 'done' ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <Copy size={16} aria-hidden="true" />
        )}
        <span>{status === 'done' ? successLabel : label}</span>
      </button>
      <span
        className={status === 'failed' ? 'ui-copy-error' : 'ui-sr-only'}
        role="status"
      >
        {status === 'failed'
          ? errorLabel
          : status === 'done'
            ? successLabel
            : ''}
      </span>
    </span>
  );
}
export function CopyField(props: Props) {
  return (
    <div className="ui-copy-field">
      <span className="ui-copy-field-value">{props.value}</span>
      <CopyButton {...props} />
    </div>
  );
}
