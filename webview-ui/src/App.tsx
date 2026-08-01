// @ts-expect-error LicenseManager is a runtime export of @tldraw/tldraw but excluded from its public types
import { Tldraw, useEditor, createShapeId, LicenseManager } from '@tldraw/tldraw';
import type { TLEventInfo } from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';
import { useEffect, Component, useRef } from 'react';
import type { ReactNode } from 'react';

const TLDRAW_LICENSE_KEY = import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined;

declare global {
    interface Window {
        acquireVsCodeApi?: () => { postMessage: (message: unknown) => void };
    }
}

const vscodeApi = typeof window !== 'undefined' ? window.acquireVsCodeApi?.() : undefined;

const SAVE_DEBOUNCE_MS = 500;

// tldraw treats the VS Code webview (vscode-webview:// protocol) as a production
// environment. Without a valid license key it hides the entire editor after ~5
// seconds, which makes the canvas appear to "close itself". Until a license key
// is configured (set VITE_TLDRAW_LICENSE_KEY), fall back to development mode.
if (!TLDRAW_LICENSE_KEY) {
  LicenseManager.prototype.getIsDevelopment = function getIsDevelopment() {
    return true;
  };
}

// 1. Bulletproof React Error Boundary (with strict TypeScript interfaces)
interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  hasError: boolean;
  error: string;
}

class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { hasError: false, error: '' };
  }

  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ position: 'fixed', inset: 0, padding: '20px', background: '#222', color: '#ff6b6b', zIndex: 9999 }}>
          <h2>React Render Crash Caught!</h2>
          <p>Please copy this exact error and paste it in our chat:</p>
          <pre style={{ background: '#000', padding: '10px', overflow: 'auto' }}>
            {this.state.error}
          </pre>
          <button onClick={() => window.location.reload()} style={{ padding: '8px 16px', marginTop: '10px' }}>
            Reload Canvas
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// 2. Listener Component
function VSCodeListener() {
  const editor = useEditor();
  const didInit = useRef(false);
  const pointerDownScreenPoint = useRef<{ x: number; y: number } | null>(null);
  const lastPointerUpTime = useRef(0);
  const navTimer = useRef<number | undefined>(undefined);
  const pendingNav = useRef<{ filePath: string; startLine: number; endLine?: number } | null>(null);

  useEffect(() => {
    if (!editor || didInit.current) {
      return;
    }
    didInit.current = true;

    let isLoading = false;

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message?.command === 'loadDocument' && editor) {
        isLoading = true;
        try {
          if (message.snapshot) {
            editor.loadSnapshot(message.snapshot);
          }
        } catch (error) {
          console.error('Failed to load saved canvas:', error);
        } finally {
          setTimeout(() => {
            isLoading = false;
          }, 0);
        }
      }

      if (message?.command === 'addPointer' && editor) {
        const { filePath, startLine, endLine } = message.data;

        try {
          const shapeId = createShapeId();
          editor.createShapes([{
            id: shapeId,
            type: 'geo',
            x: Math.max(80, (window.innerWidth / 2) - 40),
            y: Math.max(80, (window.innerHeight / 2) - 40),
            props: {
              geo: 'ellipse',
              color: 'light-blue',
              fill: 'solid',
              dash: 'solid',
              size: 's',
              w: 80,
              h: 80,
            },
            meta: { filePath, startLine, endLine },
          }]);
          editor.bringToFront([shapeId]);
        } catch (error) {
          console.error('Failed to create pointer shape:', error);
        }
      }
    };

    window.addEventListener('message', handleMessage);

    vscodeApi?.postMessage({ command: 'webviewReady' });

    const handleUiEvent = (info: TLEventInfo) => {
      if (info.type !== 'pointer') {
        return;
      }
      if (info.name === 'pointer_down' && info.button === 0) {
        pointerDownScreenPoint.current = info.point;
        if (navTimer.current) {
          clearTimeout(navTimer.current);
          navTimer.current = undefined;
          pendingNav.current = null;
        }
        return;
      }
      if (info.name !== 'pointer_up' || info.button !== 0) {
        return;
      }
      const now = performance.now();
      const isDoubleClick = now - lastPointerUpTime.current < 350;
      lastPointerUpTime.current = now;
      const down = pointerDownScreenPoint.current;
      pointerDownScreenPoint.current = null;
      if (down) {
        const dist = Math.hypot(info.point.x - down.x, info.point.y - down.y);
        if (dist > 5) {
          return;
        }
      }
      if (isDoubleClick) {
        return;
      }
      const point = editor.inputs.getCurrentPagePoint();
      const hit = editor.getShapeAtPoint(point, { hitInside: true, hitLabels: true });
      const meta = hit?.meta as { filePath?: string; startLine?: number; endLine?: number } | undefined;
      if (meta?.filePath && typeof meta.startLine === 'number') {
        pendingNav.current = {
          filePath: meta.filePath,
          startLine: meta.startLine,
          endLine: meta.endLine,
        };
        if (navTimer.current) {
          clearTimeout(navTimer.current);
        }
        navTimer.current = window.setTimeout(() => {
          if (pendingNav.current) {
            vscodeApi?.postMessage({
              command: 'navigateToCode',
              data: pendingNav.current,
            });
          }
          pendingNav.current = null;
          navTimer.current = undefined;
        }, 250);
      }
    };
    editor.on('event', handleUiEvent);

    let saveTimer: number | undefined;
    const persist = () => {
      try {
        const snapshot = editor.getSnapshot();
        vscodeApi?.postMessage({ command: 'saveDocument', snapshot });
      } catch (error) {
        console.error('Failed to save canvas:', error);
      }
    };
    const unlisten = editor.store.listen(() => {
      if (isLoading) {
        return;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = window.setTimeout(persist, SAVE_DEBOUNCE_MS);
    });

    return () => {
      window.removeEventListener('message', handleMessage);
      editor.off('event', handleUiEvent);
      unlisten();
      if (navTimer.current) {
        clearTimeout(navTimer.current);
        navTimer.current = undefined;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        persist();
      }
    };
  }, [editor]);

  return null;
}

// 3. Main App (Wrapped in the Boundary)
export default function App() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      console.error('Webview runtime error:', event.error || event.message);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('Webview unhandled rejection:', event.reason);
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return (
    <ErrorBoundary>
      <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <Tldraw licenseKey={TLDRAW_LICENSE_KEY}>
          <VSCodeListener />
        </Tldraw>
      </div>
    </ErrorBoundary>
  );
}