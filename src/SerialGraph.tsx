import { useEffect, useRef, useState } from "react";
import { Line } from 'react-chartjs-2';
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler
);

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200] as const;

function hasWebSerial(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

function formatValue(value: number | null | undefined, digits = 3): string {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "--";
}

export default function SerialGraph() {
  const [supported] = useState(hasWebSerial());
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<string>("");
  const [baudRate, setBaudRate] = useState(115200);
  const [isBaudMenuOpen, setIsBaudMenuOpen] = useState(false);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const baudMenuRef = useRef<HTMLDivElement | null>(null);

  const bufferRef = useRef("");
  const [points, setPoints] = useState<{x:number;y:number}[]>([]);
  const [data, setData] = useState<{time:number,mass:number;disp:number;angle:number}[]>([]); // for chart; updated on disconnect to freeze data

  const latestPoint = data[data.length - 1];
  const maxLoad = points.length ? Math.max(...points.map((point) => point.y)) : undefined;

  useEffect(() => {
    return () => {
      // best-effort cleanup on unmount
      void disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isBaudMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!baudMenuRef.current?.contains(event.target as Node)) {
        setIsBaudMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsBaudMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isBaudMenuOpen]);

  async function connect() {
    if (!navigator.serial) {
      alert("Web Serial not available in this browser.\n");
      return;
    }

    // Must be called from a user gesture (button click)
    const port = await navigator.serial.requestPort({
      // Optional filters:
      // filters: [{ usbVendorId: 0x2341 }], // e.g. Arduino
    });

    await port.open({ baudRate: baudRate });

    portRef.current = port;
    setConnected(true);

    // Setup writer
    if (port.writable) {
      writerRef.current = port.writable.getWriter();
    }

    // Start read loop
    abortRef.current = new AbortController();
    void readLoop(abortRef.current.signal);
  }

  async function readLoop(signal: AbortSignal) {
    const port = portRef.current;
    if (!port?.readable) return;

    const textDecoder = new TextDecoder();
    const reader = port.readable.getReader();
    readerRef.current = reader;

    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          handleMsg(textDecoder.decode(value, { stream: true }));
        }
      }
    } catch (err) {
      handleMsg(`\nRead error: ${String(err)}\n`);
    } finally {
      try {
        reader.releaseLock();
      } catch {}
      readerRef.current = null;
    }
  }

  async function send(cmd?: string) {
    const writer = writerRef.current;
    if (!writer) {
      alert("No writer/cmd available.\n");
      return;
    }
    const data = new TextEncoder().encode(cmd);
    await writer.write(data);
  }

  async function disconnect() {
    abortRef.current?.abort();
    abortRef.current = null;

    try {
      await readerRef.current?.cancel();
    } catch {}
    try {
      readerRef.current?.releaseLock();
    } catch {}
    readerRef.current = null;

    try {
      writerRef.current?.releaseLock();
    } catch {}
    writerRef.current = null;

    try {
      await portRef.current?.close();
    } catch {}
    portRef.current = null;

    setConnected(false);
    setLog((prev) => prev + "\nDisconnected.\n");
    setPoints([]);
  }

  function handleMsg(chunk: string) {
    setLog((prev) => prev + chunk);

    bufferRef.current += chunk;

    // split into lines; keep the last partial line in the buffer
    const lines = bufferRef.current.split(/\r?\n/);
    bufferRef.current = lines.pop() ?? "";

    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line) continue;

      // Expect: "reading: 0.2, 1.8"
      if (line.startsWith("reading:")) {
        const payload = line.slice("reading:".length).trim(); // "0.2, 1.8"
        const parts = payload.split(",").map(s => s.trim());
        if (parts.length >= 2) {
          const t = Number(parts[0]);
          const x = Number(parts[2]);
          let y = Number(parts[1]);
          const angle = Number(parts[3] ?? 0);
          y = (y*9.81); // convert to kN
          if (Number.isFinite(x) && Number.isFinite(y)) {
            setPoints((points) => [...points, { x, y }]);
            setData((data) => [...data, {time: t, mass: y, disp: x, angle: angle}]);
            // NOTE: ref won't re-render chart; see note below
          }
        }
      }
    }
  }

  function save() {
    const csvContent = "data:text/csv;charset=utf-8," + points.map(p => `${p.x},${p.y}`).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "compression_data.csv");
    document.body.appendChild(link); // Required for FF
    link.click();
    document.body.removeChild(link);
  }

  if (!supported) {
    return (
      <main className="app-shell unsupported-shell">
        <section className="hero-panel">
          <div className="eyebrow">Laboratory Instrument Interface</div>
          <h1>Compression Bench</h1>
          <p className="hero-copy">
            This workstation requires Web Serial support. Open it in a current desktop build of Chrome or Edge.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-heading-row">
          <div>
            <h1>Compression Bench</h1>
            <p className="hero-copy">
              Real-time load and displacement acquisition for controlled bench measurements.
            </p>
          </div>
          <div className={`status-pill ${connected ? "online" : "offline"}`}>
            <span className="status-dot" />
            {connected ? "Port connected" : "Port idle"}
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="surface chart-surface">
          <div className="surface-header">
            <div>
              <span className="section-kicker">Measurement</span>
            </div>
            <span className="surface-meta">Load vs displacement</span>
          </div>

          <div className="chart-summary-grid">
            <article className="summary-chip primary">
              <span className="metric-label">Load</span>
              <strong className="summary-value">{formatValue(latestPoint?.mass*9.81)}</strong>
              <span className="metric-unit">kN</span>
            </article>
            <article className="summary-chip">
              <span className="metric-label">Displacement</span>
              <strong className="summary-value">{formatValue(latestPoint?.disp)}</strong>
              <span className="metric-unit">mm</span>
            </article>
            <article className="summary-chip">
              <span className="metric-label">Peak</span>
              <strong className="summary-value">{formatValue(maxLoad)}</strong>
              <span className="metric-unit">kN</span>
            </article>
            <article className="summary-chip">
              <span className="metric-label">Angle</span>
              <strong className="summary-value">{formatValue(latestPoint?.angle)}</strong>
              <span className="metric-unit">°</span>
            </article>
            <article className="summary-chip">
              <span className="metric-label">Samples</span>
              <strong className="summary-value">{points.length? points.length : "--"}</strong>
              <span className="metric-unit">pts</span>
            </article>
          </div>

          <div className="chart-frame">
            <Line
              data={{
                labels: points.map((point) => point.x),
                datasets: [
                  {
                    label: "Load",
                    data: points.map((point) => point.y),
                    borderColor: "#0f5f52",
                    backgroundColor: "rgba(15, 95, 82, 0.12)",
                    borderWidth: 2,
                    fill: true,
                    tension: 0.18,
                    pointRadius: 0,
                    pointHitRadius: 10,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                  legend: {
                    display: false,
                  },
                  tooltip: {
                    backgroundColor: "#15211d",
                    titleColor: "#f3f6f4",
                    bodyColor: "#d5ddda",
                    borderColor: "rgba(255, 255, 255, 0.12)",
                    borderWidth: 1,
                    displayColors: false,
                    callbacks: {
                      title(items) {
                        return `Displacement ${items[0]?.label ?? "--"} mm`;
                      },
                      label(context) {
                        return `Load ${formatValue(context.parsed.y)} kN`;
                      },
                    },
                  },
                },
                scales: {
                  x: {
                    title: {
                      display: true,
                      text: "Displacement (mm)",
                    },
                    grid: {
                      color: "rgba(14, 31, 26, 0.08)",
                    },
                    ticks: {
                      color: "#5d6864",
                    },
                  },
                  y: {
                    title: {
                      display: true,
                      text: "Load (kN)",
                    },
                    grid: {
                      color: "rgba(14, 31, 26, 0.08)",
                    },
                    ticks: {
                      color: "#5d6864",
                    },
                  },
                },
              }}
            />
          </div>
        </div>

        <div className="support-grid">
          <div className="surface control-surface">
            <div className="surface-header compact">
              <div>
                <span className="section-kicker">Connection</span>
              </div>
            </div>

            <label className="field-label" htmlFor="baudRate">
              Serial baud rate
            </label>
            <div className="control-row">
              <div
                ref={baudMenuRef}
                className={`select-shell ${isBaudMenuOpen ? "open" : ""}`}
              >
                <button
                  type="button"
                  id="baudRate"
                  className="select-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={isBaudMenuOpen}
                  aria-label="Serial baud rate"
                  onClick={() => setIsBaudMenuOpen((open) => !open)}
                >
                  <span className="select-value">{baudRate}</span>
                </button>

                {isBaudMenuOpen ? (
                  <div className="select-menu" role="listbox" aria-label="Serial baud rate options">
                    {BAUD_RATES.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        role="option"
                        aria-selected={baudRate === rate}
                        className={`select-option ${baudRate === rate ? "selected" : ""}`}
                        onClick={() => {
                          setBaudRate(rate);
                          setIsBaudMenuOpen(false);
                        }}
                      >
                        {rate}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {!connected ? (
                <button className="button primary-button" onClick={connect}>
                  Connect
                </button>
              ) : (
                <button className="button" onClick={() => void disconnect()}>
                  Disconnect
                </button>
              )}
            </div>

            <div className="button-grid">
              <button className="button primary-button" onClick={() => void send("start")} disabled={!connected}>
                Start
              </button>
              <button className="button" onClick={() => void send("stop")} disabled={!connected}>
                Stop
              </button>
              <button className="button" onClick={() => void send("tare")} disabled={!connected}>
                Tare
              </button>
              <button className="button" onClick={() => void send("steptest")} disabled={!connected}>
                Step Test
              </button>
            </div>

            <div className="button-grid secondary-grid">
              <button className="button subtle-button" onClick={() => (setLog(""), setPoints([]))}>
                Clear Session
              </button>
              <button className="button subtle-button" onClick={() => void save()} disabled={!points.length}>
                Export CSV
              </button>
            </div>
          </div>

          <div className="surface log-surface">
            <div className="surface-header compact">
              <div>
                <span className="section-kicker">Serial Monitor</span>
              </div>
            </div>
            <pre className="log-panel">{log || "Awaiting incoming data stream."}</pre>
          </div>
        </div>
      </section>
    </main>
  );
}