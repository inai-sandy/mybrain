import { createContext, ReactNode, useCallback, useContext, useState } from 'react';

type Kind = 'success' | 'error';
type Toast = { id: number; kind: Kind; msg: string };

const Ctx = createContext<{ toast: (kind: Kind, msg: string) => void }>({ toast: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((kind: Kind, msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 space-y-2 z-50">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={'px-4 py-2 rounded-lg text-sm text-white shadow-lg ' + (t.kind === 'success' ? 'bg-emerald-600' : 'bg-red-600')}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx).toast;
