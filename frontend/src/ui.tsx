import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

/* ---------- Icons (inline SVG — no icon library) ---------- */

type IconProps = { size?: number };

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconClock = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

export const IconUsers = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" />
    <circle cx="9" cy="7" r="3" />
    <path d="M22 19v-1a4 4 0 0 0-3-3.87" />
    <path d="M16 4.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconSettings = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.35.4.65.73.85.3.18.65.28 1 .28H21a2 2 0 1 1 0 4h-.09c-.35 0-.7.1-1 .28-.33.2-.59.5-.73.85z" />
  </Svg>
);

export const IconSun = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const IconMoon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
);

export const IconPaperclip = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.2-9.19a3.67 3.67 0 1 1 5.18 5.18l-9.2 9.2a1.83 1.83 0 0 1-2.6-2.6l8.5-8.48" />
  </Svg>
);

export const IconX = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const IconBack = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
);

export const IconPhone = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2z" />
  </Svg>
);

export const IconSend = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </Svg>
);

/* ---------- Layout ---------- */

export function Page({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>;
}

export function TopBar({
  title,
  back,
  right,
}: {
  title: string;
  back?: string;
  right?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-left">
          {back && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Go back"
              onClick={() => navigate(back)}
            >
              <IconBack />
            </button>
          )}
          <span className="topbar-title">{title}</span>
        </div>
        <div className="topbar-right">{right}</div>
      </div>
    </header>
  );
}

export function Content({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <main className={`content${wide ? ' wide' : ''}`}>{children}</main>;
}

export function Hero({
  badge,
  title,
  children,
}: {
  badge?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="hero">
      {badge && <span className="hero-badge">{badge}</span>}
      <h1 className="brand">{title}</h1>
      {children && <p className="lede">{children}</p>}
    </div>
  );
}

/* ---------- Controls ---------- */

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  to?: string;
  variant?: 'solid' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  loading?: boolean;
  full?: boolean;
  type?: 'button' | 'submit';
};

export function Button({
  children,
  onClick,
  to,
  variant = 'solid',
  size = 'md',
  disabled,
  loading,
  full,
  type = 'button',
}: ButtonProps) {
  const cls = `btn btn-${variant} btn-${size}${full ? ' btn-full' : ''}`;
  if (to && !disabled) {
    return (
      <Link className={cls} to={to}>
        {children}
      </Link>
    );
  }
  return (
    <button className={cls} type={type} onClick={onClick} disabled={disabled || loading}>
      {loading ? <Spinner /> : children}
    </button>
  );
}

export function IconButton({
  children,
  onClick,
  to,
  label,
}: {
  children: ReactNode;
  onClick?: () => void;
  to?: string;
  label: string;
}) {
  if (to) {
    return (
      <Link className="icon-btn" to={to} aria-label={label} title={label}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label={label} title={label}>
      {children}
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={`spinner${small ? ' spinner-sm' : ''}`} role="status" aria-label="Loading" />;
}

export function Card({
  children,
  highlight,
  className = '',
}: {
  children: ReactNode;
  highlight?: boolean;
  className?: string;
}) {
  return <section className={`card${highlight ? ' card-hl' : ''} ${className}`.trim()}>{children}</section>;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="field-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function AutoTextarea({
  value,
  onChange,
  placeholder,
  minRows = 3,
  onSubmit,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
  onSubmit?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className={`textarea ${className}`.trim()}
      rows={minRows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (onSubmit && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

export function Pill({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'bad' | 'live' }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="note">{children}</p>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-err">{children}</p>;
}

export function OkText({ children }: { children: ReactNode }) {
  return <p className="text-ok">{children}</p>;
}

/* ---------- Theme ---------- */

export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('apa.theme.v1') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem('apa.theme.v1', next);
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.theme = next;
  }

  return { theme, toggle };
}
