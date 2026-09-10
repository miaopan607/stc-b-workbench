use std::time::Duration;

use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};

use crate::models::SerialPortDescriptor;
use crate::protocol::{build_bar_frame, build_stereo_bar_frame, FRAME_LENGTH};

pub fn list_ports() -> Result<Vec<SerialPortDescriptor>, String> {
    let ports = serialport::available_ports().map_err(|error| error.to_string())?;
    Ok(ports
        .into_iter()
        .map(|port| {
            let friendly_name = match port.port_type {
                SerialPortType::UsbPort(info) => {
                    let product = info.product.unwrap_or_default();
                    let manufacturer = info.manufacturer.unwrap_or_default();
                    match (manufacturer.is_empty(), product.is_empty()) {
                        (false, false) => format!("{manufacturer} {product}"),
                        (false, true) => manufacturer,
                        (true, false) => product,
                        (true, true) => "USB 串口".to_owned(),
                    }
                }
                SerialPortType::BluetoothPort => "Bluetooth 串口".to_owned(),
                SerialPortType::PciPort => "PCI 串口".to_owned(),
                SerialPortType::Unknown => "未知串口设备".to_owned(),
            };
            SerialPortDescriptor {
                name: port.port_name,
                friendly_name,
            }
        })
        .collect())
}

pub fn open_port(name: &str) -> Result<Box<dyn SerialPort>, String> {
    if name.trim().is_empty() {
        return Err("未选择串口".to_owned());
    }

    serialport::new(name, 115_200)
        .data_bits(DataBits::Eight)
        .parity(Parity::None)
        .stop_bits(StopBits::One)
        .flow_control(FlowControl::None)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|error| error.to_string())
}

pub fn write_bars(
    port: &mut dyn SerialPort,
    sequence: u8,
    bars: u8,
) -> Result<(), String> {
    let frame = build_bar_frame(sequence, bars).map_err(|error| error.to_string())?;
    port.write_all(&frame[..FRAME_LENGTH])
        .map_err(|error| error.to_string())
}

pub fn write_stereo_bars(
    port: &mut dyn SerialPort,
    left: u8,
    right: u8,
) -> Result<(), String> {
    let frame = build_stereo_bar_frame(left, right).map_err(|error| error.to_string())?;
    port.write_all(&frame[..FRAME_LENGTH])
        .map_err(|error| error.to_string())
}
