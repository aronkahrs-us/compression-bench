import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import serial
import serial.tools.list_ports
import threading
import queue
import csv
import time
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg

class StepperTestBenchGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Mechanical Test Bench Controller")
        self.root.geometry("1300x850")

        self.ser = None
        self.is_reading = False
        self.data_history = []  # Stores: (Time, Mass, Disp, Angle, Count, Missed, Cycle)
        self.log_queue = queue.Queue()

        self._build_ui()
        self._refresh_ports()
        
        # Periodic GUI updates
        self.root.after(100, self._update_gui_log)
        self.root.after(100, self._update_plots)

    def _build_ui(self):
        # Top Frame: Serial Connection
        conn_frame = ttk.LabelFrame(self.root, text="Serial Connection")
        conn_frame.pack(fill="x", padx=10, pady=5)

        ttk.Label(conn_frame, text="Port:").grid(row=0, column=0, padx=5, pady=5)
        self.port_cb = ttk.Combobox(conn_frame, width=15)
        self.port_cb.grid(row=0, column=1, padx=5, pady=5)

        ttk.Button(conn_frame, text="Refresh", command=self._refresh_ports).grid(row=0, column=2, padx=5, pady=5)

        ttk.Label(conn_frame, text="Baud:").grid(row=0, column=3, padx=5, pady=5)
        self.baud_entry = ttk.Entry(conn_frame, width=10)
        self.baud_entry.insert(0, "115200")
        self.baud_entry.grid(row=0, column=4, padx=5, pady=5)

        self.btn_connect = ttk.Button(conn_frame, text="Connect", command=self._toggle_connection)
        self.btn_connect.grid(row=0, column=5, padx=10, pady=5)

        # Main Layout: Left Controls, Right Plots
        main_pane = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        main_pane.pack(fill="both", expand=True, padx=10, pady=5)

        # Control Panel (Left)
        ctrl_frame = ttk.Frame(main_pane, width=320)
        main_pane.add(ctrl_frame, weight=1)

        # Live Metrics Panel
        metric_frame = ttk.LabelFrame(ctrl_frame, text="Live Telemetry")
        metric_frame.pack(fill="x", padx=5, pady=5)

        ttk.Label(metric_frame, text="Force:").grid(row=0, column=0, sticky="w", padx=5, pady=2)
        self.lbl_force = ttk.Label(metric_frame, text="0.000 kg", font=("Arial", 10, "bold"))
        self.lbl_force.grid(row=0, column=1, sticky="e", padx=5, pady=2)

        ttk.Label(metric_frame, text="Displacement:").grid(row=1, column=0, sticky="w", padx=5, pady=2)
        self.lbl_disp = ttk.Label(metric_frame, text="0.00 mm", font=("Arial", 10, "bold"))
        self.lbl_disp.grid(row=1, column=1, sticky="e", padx=5, pady=2)

        ttk.Label(metric_frame, text="Missed Steps:").grid(row=2, column=0, sticky="w", padx=5, pady=2)
        self.lbl_missed = ttk.Label(metric_frame, text="0", font=("Arial", 10, "bold"), foreground="red")
        self.lbl_missed.grid(row=2, column=1, sticky="e", padx=5, pady=2)

        ttk.Label(metric_frame, text="Current Cycle:").grid(row=3, column=0, sticky="w", padx=5, pady=2)
        self.lbl_cycle = ttk.Label(metric_frame, text="0 / 0", font=("Arial", 10, "bold"))
        self.lbl_cycle.grid(row=3, column=1, sticky="e", padx=5, pady=2)

        # Test Parameters Box
        param_frame = ttk.LabelFrame(ctrl_frame, text="Test Parameters")
        param_frame.pack(fill="x", padx=5, pady=5)

        ttk.Label(param_frame, text="Target Force (kg):").grid(row=0, column=0, sticky="w", padx=5, pady=5)
        self.target_entry = ttk.Entry(param_frame, width=10)
        self.target_entry.insert(0, "20.0")
        self.target_entry.grid(row=0, column=1, padx=5, pady=5)

        ttk.Label(param_frame, text="Baseline Force (kg):").grid(row=1, column=0, sticky="w", padx=5, pady=5)
        self.base_entry = ttk.Entry(param_frame, width=10)
        self.base_entry.insert(0, "0.01")
        self.base_entry.grid(row=1, column=1, padx=5, pady=5)

        ttk.Label(param_frame, text="Number of Cycles:").grid(row=2, column=0, sticky="w", padx=5, pady=5)
        self.cycles_entry = ttk.Entry(param_frame, width=10)
        self.cycles_entry.insert(0, "55")
        self.cycles_entry.grid(row=2, column=1, padx=5, pady=5)

        ttk.Button(param_frame, text="Send Parameters", command=self._send_parameters).grid(row=3, column=0, columnspan=2, pady=8)

        # Commands Box
        cmd_frame = ttk.LabelFrame(ctrl_frame, text="Control Commands")
        cmd_frame.pack(fill="x", padx=5, pady=5)

        self.btn_start = ttk.Button(cmd_frame, text="▶ START TEST", command=lambda: self._send_cmd("start"))
        self.btn_start.pack(fill="x", padx=5, pady=4)

        self.btn_stop = ttk.Button(cmd_frame, text="⏹ EMERGENCY STOP", command=lambda: self._send_cmd("stop"))
        self.btn_stop.pack(fill="x", padx=5, pady=4)

        ttk.Button(cmd_frame, text="Tare Loadcell", command=lambda: self._send_cmd("tare")).pack(fill="x", padx=5, pady=2)

        # Data Management
        data_frame = ttk.LabelFrame(ctrl_frame, text="Data Export")
        data_frame.pack(fill="x", padx=5, pady=5)

        ttk.Button(data_frame, text="Clear Plot Data", command=self._clear_data).pack(fill="x", padx=5, pady=2)
        ttk.Button(data_frame, text="💾 Save to CSV", command=self._save_csv).pack(fill="x", padx=5, pady=4)

        # Console Output
        log_frame = ttk.LabelFrame(ctrl_frame, text="Serial Console")
        log_frame.pack(fill="both", expand=True, padx=5, pady=5)

        self.log_text = tk.Text(log_frame, height=8, width=30, state="disabled")
        self.log_text.pack(fill="both", expand=True)

        # Plot Panel (Right) - 2x2 Grid Layout
        plot_frame = ttk.Frame(main_pane)
        main_pane.add(plot_frame, weight=3)

        self.fig, ((self.ax_force, self.ax_hysteresis), (self.ax_disp, self.ax_missed)) = plt.subplots(2, 2, figsize=(9, 8))
        self.fig.tight_layout(pad=3.0)

        # Subplot 1: Force vs Time (Top-Left)
        self.line_force, = self.ax_force.plot([], [], 'r-', label="Force (kg)")
        self.ax_force.set_xlabel("Time [s]")
        self.ax_force.set_ylabel("Force [kg]")
        self.ax_force.set_title("Force vs Time")
        self.ax_force.grid(True)
        self.ax_force.legend(loc="upper right")

        # Subplot 2: Hysteresis Loop - Force vs Displacement (Top-Right)
        self.line_hysteresis, = self.ax_hysteresis.plot([], [], 'g-', label="Force vs Disp")
        self.ax_hysteresis.set_xlabel("Displacement [mm]")
        self.ax_hysteresis.set_ylabel("Force [kg]")
        self.ax_hysteresis.set_title("Load-Unload Hysteresis")
        self.ax_hysteresis.grid(True)
        self.ax_hysteresis.legend(loc="upper left")

        # Subplot 3: Displacement vs Time (Bottom-Left)
        self.line_disp, = self.ax_disp.plot([], [], 'b-', label="Displacement (mm)")
        self.ax_disp.set_xlabel("Time [s]")
        self.ax_disp.set_ylabel("Displacement [mm]")
        self.ax_disp.set_title("Displacement vs Time")
        self.ax_disp.grid(True)
        self.ax_disp.legend(loc="upper right")

        # Subplot 4: Missed Steps vs Time (Bottom-Right)
        self.line_missed, = self.ax_missed.plot([], [], 'm-', label="Missed Steps")
        self.ax_missed.set_xlabel("Time [s]")
        self.ax_missed.set_ylabel("Steps")
        self.ax_missed.set_title("Closed-Loop Step Corrections")
        self.ax_missed.grid(True)
        self.ax_missed.legend(loc="upper left")

        self.canvas = FigureCanvasTkAgg(self.fig, master=plot_frame)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)

    def _refresh_ports(self):
        ports = [port.device for port in serial.tools.list_ports.comports()]
        self.port_cb['values'] = ports
        if ports:
            self.port_cb.current(0)

    def _toggle_connection(self):
        if self.ser and self.ser.is_open:
            self.is_reading = False
            self.ser.close()
            self.btn_connect.config(text="Connect")
            self._log("[SYSTEM] Disconnected.")
        else:
            port = self.port_cb.get()
            baud = self.baud_entry.get()
            try:
                self.ser = serial.Serial(port, int(baud), timeout=1)
                self.is_reading = True
                self.btn_connect.config(text="Disconnect")
                self._log(f"[SYSTEM] Connected to {port} @ {baud}")
                
                threading.Thread(target=self._read_serial, daemon=True).start()
            except Exception as e:
                messagebox.showerror("Connection Error", str(e))

    def _send_cmd(self, cmd):
        if self.ser and self.ser.is_open:
            self.ser.write(f"{cmd}\n".encode('utf-8'))
            self._log(f">> {cmd}")
        else:
            messagebox.showwarning("Warning", "Serial port not connected.")

    def _send_parameters(self):
        target = self.target_entry.get()
        base = self.base_entry.get()
        cycles = self.cycles_entry.get()

        self._send_cmd(f"target {target}")
        time.sleep(0.05)
        self._send_cmd(f"base {base}")
        time.sleep(0.05)
        self._send_cmd(f"cycles {cycles}")

    def _read_serial(self):
        while self.is_reading and self.ser and self.ser.is_open:
            try:
                line = self.ser.readline().decode('utf-8', errors='ignore').strip()
                if not line:
                    continue
                
                if line.startswith("DATA,"):
                    parts = line.split(",")
                    if len(parts) == 8:
                        t = float(parts[1])
                        mass = float(parts[2])
                        disp = float(parts[3])
                        angle = float(parts[4])
                        cnt = int(parts[5])
                        missed = int(parts[6])
                        cycle = int(parts[7])

                        self.data_history.append((t, mass, disp, angle, cnt, missed, cycle))
                else:
                    self.log_queue.put(f"<< {line}")
            except Exception:
                pass

    def _update_gui_log(self):
        while not self.log_queue.empty():
            msg = self.log_queue.get()
            self._log(msg)
        self.root.after(100, self._update_gui_log)

    def _log(self, text):
        self.log_text.config(state="normal")
        self.log_text.insert("end", text + "\n")
        self.log_text.see("end")
        self.log_text.config(state="disabled")

    def _update_plots(self):
        if self.data_history:
            times = [d[0] for d in self.data_history]
            forces = [d[1] for d in self.data_history]
            disps = [d[2] for d in self.data_history]
            missed = [d[5] for d in self.data_history]

            # Update Plot Lines
            self.line_force.set_data(times, forces)
            self.line_hysteresis.set_data(disps, forces)
            self.line_disp.set_data(times, disps)
            self.line_missed.set_data(times, missed)

            # Rescale Subplots
            for ax in (self.ax_force, self.ax_hysteresis, self.ax_disp, self.ax_missed):
                ax.relim()
                ax.autoscale_view()

            self.canvas.draw_idle()

            # Update Live Numeric Labels
            last_entry = self.data_history[-1]
            self.lbl_force.config(text=f"{last_entry[1]:.3f} kg")
            self.lbl_disp.config(text=f"{last_entry[2]:.2f} mm")
            self.lbl_missed.config(text=f"{last_entry[5]}")
            self.lbl_cycle.config(text=f"{last_entry[6]} / {self.cycles_entry.get()}")

        self.root.after(200, self._update_plots)

    def _clear_data(self):
        self.data_history.clear()
        self.line_force.set_data([], [])
        self.line_hysteresis.set_data([], [])
        self.line_disp.set_data([], [])
        self.line_missed.set_data([], [])
        self.canvas.draw()
        
        self.lbl_force.config(text="0.000 kg")
        self.lbl_disp.config(text="0.00 mm")
        self.lbl_missed.config(text="0")
        self.lbl_cycle.config(text="0 / 0")
        self._log("[SYSTEM] Data log cleared.")

    def _save_csv(self):
        if not self.data_history:
            messagebox.showinfo("Info", "No data to save.")
            return

        filename = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")]
        )

        if filename:
            try:
                with open(filename, mode='w', newline='') as file:
                    writer = csv.writer(file)
                    writer.writerow(["Time_s", "Mass_kg", "Displacement_mm", "Angle_deg", "Encoder_Count", "Steps_Missed", "Cycle"])
                    writer.writerows(self.data_history)
                messagebox.showinfo("Success", f"Data exported to {filename}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save file: {str(e)}")

if __name__ == "__main__":
    root = tk.Tk()
    app = StepperTestBenchGUI(root)
    root.mainloop()
