import { useEffect, useRef, useState } from "react";
import { Line } from "react-chartjs-2";
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

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200] as const;
const CSV_HEADER = "Time_s,Mass_kg,Displacement_mm,Angle_deg,Encoder_Count,Steps_Missed,Cycle";

type Measurement = {
  time: number;
  mass: number;
  displacement: number;
  angle: number;
  encoderCount: number;
  stepsMissed: number;
  cycle: number;
};

function hasWebSerial(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

function formatValue(value: number | undefined, digits = 3): string {
  return value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function parseDataLine(line: string): Measurement | null {
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length !== 8 || parts[0] !== "DATA") return null;
  const values = parts.slice(1).map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  return {
    time: values[0],
    mass: values[1],
    displacement: values[2],
    angle: values[3],
    encoderCount: values[4],
    stepsMissed: values[5],
    cycle: values[6],
  };
}

function chartOptions(xTitle: string, yTitle: string) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    plugins: { legend: { display: false } },
    scales: {
      x: { title: { display: true, text: xTitle }, grid: { color: "rgba(14, 31, 26, 0.08)" } },
      y: { title: { display: true, text: yTitle }, grid: { color: "rgba(14, 31, 26, 0.08)" } },
    },
  };
}

export default function SerialGraph() {
  const [supported] = useState(hasWebSerial());
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState("");
  const [baudRate, setBaudRate] = useState(115200);
  const [data, setData] = useState<Measurement[]>([]);
  const [target, setTarget] = useState("20.0");
  const [baseline, setBaseline] = useState("0.01");
  const [cycles, setCycles] = useState("55");

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bufferRef = useRef("");

  const latest = data[data.length - 1];
  const peak = data.length ? Math.max(...data.map((point) => point.mass)) : undefined;

  useEffect(() => () => { void disconnect(); }, []);

  async function connect() {
    if (!navigator.serial) {
      setLog((previous) => `${previous}\nWeb Serial is not available in this browser.`);
      return;
    }
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate });
      portRef.current = port;
      writerRef.current = port.writable?.getWriter() ?? null;
      abortRef.current = new AbortController();
      setConnected(true);
      setLog((previous) => `${previous}\nConnected at ${baudRate} baud.`);
      void readLoop(abortRef.current.signal);
    } catch (error) {
      setLog((previous) => `${previous}\nConnection error: ${String(error)}`);
    }
  }

  async function readLoop(signal: AbortSignal) {
    const port = portRef.current;
    if (!port?.readable) return;
    const reader = port.readable.getReader();
    readerRef.current = reader;
    const decoder = new TextDecoder();
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const lines = (bufferRef.current + decoder.decode(value, { stream: true })).split(/\r?\n/);
        bufferRef.current = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          const measurement = parseDataLine(line);
          if (measurement) setData((previous) => [...previous, measurement]);
          else setLog((previous) => `${previous}\n${line}`);
        }
      }
    } catch (error) {
      if (!signal.aborted) setLog((previous) => `${previous}\nRead error: ${String(error)}`);
    } finally {
      reader.releaseLock();
      readerRef.current = null;
    }
  }

  async function disconnect() {
    abortRef.current?.abort();
    abortRef.current = null;
    await readerRef.current?.cancel().catch(() => undefined);
    readerRef.current = null;
    writerRef.current?.releaseLock();
    writerRef.current = null;
    await portRef.current?.close().catch(() => undefined);
    portRef.current = null;
    setConnected(false);
  }

  async function send(command: string) {
    if (!writerRef.current) {
      setLog((previous) => `${previous}\nNot connected.`);
      return;
    }
    try {
      await writerRef.current.write(new TextEncoder().encode(`${command}\n`));
      setLog((previous) => `${previous}\n>> ${command}`);
    } catch (error) {
      setLog((previous) => `${previous}\nWrite error: ${String(error)}`);
    }
  }

  async function sendParameters() {
    await send(`target ${target}`);
    await send(`base ${baseline}`);
    await send(`cycles ${cycles}`);
  }

  function clearSession() {
    setData([]);
    setLog("");
  }

  function exportCsv() {
    const rows = data.map((point) =>
      [point.time, point.mass, point.displacement, point.angle, point.encoderCount, point.stepsMissed, point.cycle].join(","),
    );
    const blob = new Blob([[CSV_HEADER, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "compression_data.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  if (!supported) {
    return <main className="app-shell unsupported-shell"><section className="hero-panel"><h1>Compression Bench</h1><p className="hero-copy">Open this application in a current desktop version of Chrome or Edge with Web Serial support.</p></section></main>;
  }

  const labels = data.map((point) => point.time);
  const chart = (x: number[], y: number[], label: string, color: string) => ({
    labels: x,
    datasets: [{ label, data: y, borderColor: color, backgroundColor: `${color}1f`, borderWidth: 2, fill: true, tension: 0.18, pointRadius: 0 }],
  });

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-heading-row"><div><h1>Compression Bench</h1><p className="hero-copy">Real-time force and displacement acquisition for controlled bench measurements.</p></div><div className={`status-pill ${connected ? "online" : "offline"}`}><span className="status-dot" />{connected ? "Port connected" : "Port idle"}</div></div>
      </section>
      <section className="workspace-grid">
        <div className="surface chart-surface">
          <div className="surface-header"><span className="section-kicker">Measurement</span><span className="surface-meta">Live telemetry</span></div>
          <div className="chart-summary-grid">
            <article className="summary-chip primary"><span className="metric-label">Force</span><strong className="summary-value">{formatValue(latest?.mass)}</strong><span className="metric-unit">kg</span></article>
            <article className="summary-chip"><span className="metric-label">Displacement</span><strong className="summary-value">{formatValue(latest?.displacement, 2)}</strong><span className="metric-unit">mm</span></article>
            <article className="summary-chip"><span className="metric-label">Peak</span><strong className="summary-value">{formatValue(peak)}</strong><span className="metric-unit">kg</span></article>
            <article className="summary-chip"><span className="metric-label">Missed steps</span><strong className="summary-value">{latest?.stepsMissed ?? "--"}</strong><span className="metric-unit">steps</span></article>
            <article className="summary-chip"><span className="metric-label">Cycle</span><strong className="summary-value">{latest ? `${latest.cycle} / ${cycles}` : "--"}</strong><span className="metric-unit">cycles</span></article>
          </div>
          <div className="chart-grid">
            <div className="chart-frame"><Line data={chart(labels, data.map((p) => p.mass), "Force", "#0f5f52")} options={chartOptions("Time (s)", "Force (kg)")} /></div>
            <div className="chart-frame"><Line data={chart(data.map((p) => p.displacement), data.map((p) => p.mass), "Force vs displacement", "#16806e")} options={chartOptions("Displacement (mm)", "Force (kg)")} /></div>
            <div className="chart-frame"><Line data={chart(labels, data.map((p) => p.displacement), "Displacement", "#245fa8")} options={chartOptions("Time (s)", "Displacement (mm)")} /></div>
            <div className="chart-frame"><Line data={chart(labels, data.map((p) => p.stepsMissed), "Missed steps", "#a43c8f")} options={chartOptions("Time (s)", "Steps")} /></div>
          </div>
        </div>
        <div className="support-grid">
          <div className="surface control-surface">
            <div className="surface-header compact"><span className="section-kicker">Connection and test control</span></div>
            <label className="field-label" htmlFor="baudRate">Serial baud rate</label>
            <div className="control-row"><select id="baudRate" value={baudRate} onChange={(event) => setBaudRate(Number(event.target.value))}>{BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}</select>{connected ? <button className="button" onClick={() => void disconnect()}>Disconnect</button> : <button className="button primary-button" onClick={() => void connect()}>Connect</button>}</div>
            <div className="parameter-grid">
              <label>Target force (kg)<input value={target} onChange={(event) => setTarget(event.target.value)} /></label>
              <label>Baseline force (kg)<input value={baseline} onChange={(event) => setBaseline(event.target.value)} /></label>
              <label>Number of cycles<input value={cycles} onChange={(event) => setCycles(event.target.value)} /></label>
            </div>
            <button className="button primary-button full-button" onClick={() => void sendParameters()} disabled={!connected}>Send parameters</button>
            <div className="button-grid"><button className="button primary-button" onClick={() => void send("start")} disabled={!connected}>Start</button><button className="button" onClick={() => void send("stop")} disabled={!connected}>Stop</button><button className="button" onClick={() => void send("tare")} disabled={!connected}>Tare</button><button className="button" onClick={() => void send("encoder")} disabled={!connected}>Encoder</button></div>
            <div className="button-grid secondary-grid"><button className="button subtle-button" onClick={clearSession}>Clear session</button><button className="button subtle-button" onClick={exportCsv} disabled={!data.length}>Export CSV</button></div>
          </div>
          <div className="surface log-surface"><div className="surface-header compact"><span className="section-kicker">Serial monitor</span></div><pre className="log-panel">{log || "Awaiting incoming data stream."}</pre></div>
        </div>
      </section>
    </main>
  );
}
