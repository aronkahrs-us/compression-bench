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

function hasWebSerial(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

export default function SerialGraph() {
  const [supported] = useState(hasWebSerial());
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<string>("");
  const [baudRate, setBaudRate] = useState(115200);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const bufferRef = useRef("");
  const [points, setPoints] = useState<{x:number;y:number}[]>([]);

  useEffect(() => {
    return () => {
      // best-effort cleanup on unmount
      void disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          const x = Number(parts[0]);
          const y = Number(parts[1]);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            setPoints((points) => [...points, { x, y }]);
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
      <div>
        <h2>Compression Stand</h2>
        <p>
          This browser doesn't support the Web Serial API. Try Chrome or Edge on desktop.
        </p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 900 }}>
      <h2>Compression Stand</h2>

      <div>
        <Line
          data={{
            labels: points.map(point => point.x),
            datasets: [
              {
                label: 'Series 1',
                data: points.map(point => point.y),
              },
            ],
          }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {!connected ? (
        <>
          <select name="baudRate" id="baudRate" value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))}>
            <option value={9600}>9600</option>
            <option value={19200}>19200</option>
            <option value={38400}>38400</option>
            <option value={57600}>57600</option>
            <option value={115200}>115200</option>
          </select>
          <button onClick={connect}>Connect</button>
        </>
        ) : (
          <button onClick={() => void disconnect()}>Disconnect</button>
        )}
        <button onClick={() => (setLog(""),setPoints([]))}>Clear</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={() => void send("start")} disabled={!connected}>
          Start
        </button>
        <button onClick={() => void send("stop")} disabled={!connected}>
          Stop
        </button>
        <button onClick={() => void send("tare")} disabled={!connected}>
          Tare
        </button>
        <button onClick={() => void send("steptest")} disabled={!connected}>
          Step Test
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        
        <button onClick={() => void save()} disabled={!connected}>
          Save
        </button>
      </div>

      <pre
        style={{
          background: "#111",
          color: "#0f0",
          padding: 12,
          height: 320,
          overflow: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {log || "(no data yet)"}
      </pre>
    </div>
  );
}