use std::fmt;

pub const FRAME_HEAD: [u8; 2] = [0xAA, 0x5A];
pub const FRAME_TYPE_BAR_V1: u8 = 0x20;
pub const FRAME_TYPE_BAR_STEREO_V1: u8 = 0x26;
pub const FRAME_LENGTH: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BarFrame {
    pub sequence: u8,
    pub bars: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidLength { actual: usize },
    InvalidHeader,
    InvalidType { actual: u8 },
    InvalidBars { actual: u8 },
    InvalidChecksum { expected: u8, actual: u8 },
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLength { actual } => write!(f, "invalid frame length: {actual}"),
            Self::InvalidHeader => write!(f, "invalid frame header"),
            Self::InvalidType { actual } => write!(f, "invalid frame type: {actual:#04X}"),
            Self::InvalidBars { actual } => write!(f, "bars out of range: {actual}"),
            Self::InvalidChecksum { expected, actual } => write!(
                f,
                "invalid checksum: expected {expected:#04X}, got {actual:#04X}"
            ),
        }
    }
}

impl std::error::Error for ProtocolError {}

pub fn build_bar_frame(sequence: u8, bars: u8) -> Result<[u8; FRAME_LENGTH], ProtocolError> {
    if bars > 8 {
        return Err(ProtocolError::InvalidBars { actual: bars });
    }
    Ok([
        FRAME_HEAD[0],
        FRAME_HEAD[1],
        FRAME_TYPE_BAR_V1,
        sequence,
        bars,
        FRAME_TYPE_BAR_V1 ^ sequence ^ bars,
    ])
}

pub fn parse_bar_frame(frame: &[u8]) -> Result<BarFrame, ProtocolError> {
    if frame.len() != FRAME_LENGTH {
        return Err(ProtocolError::InvalidLength { actual: frame.len() });
    }
    if frame[0..2] != FRAME_HEAD {
        return Err(ProtocolError::InvalidHeader);
    }
    if frame[2] != FRAME_TYPE_BAR_V1 {
        return Err(ProtocolError::InvalidType { actual: frame[2] });
    }
    if frame[4] > 8 {
        return Err(ProtocolError::InvalidBars { actual: frame[4] });
    }
    let expected = FRAME_TYPE_BAR_V1 ^ frame[3] ^ frame[4];
    if frame[5] != expected {
        return Err(ProtocolError::InvalidChecksum {
            expected,
            actual: frame[5],
        });
    }
    Ok(BarFrame {
        sequence: frame[3],
        bars: frame[4],
    })
}

/// 双声道律动帧：AA 5A 26 L R chk，chk = 0x26 ^ L ^ R。
/// 板端每位数码管上半段显示左声道、下半段显示右声道（各 0..8 格）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StereoBarFrame {
    pub left: u8,
    pub right: u8,
}

pub fn build_stereo_bar_frame(left: u8, right: u8) -> Result<[u8; FRAME_LENGTH], ProtocolError> {
    if left > 8 {
        return Err(ProtocolError::InvalidBars { actual: left });
    }
    if right > 8 {
        return Err(ProtocolError::InvalidBars { actual: right });
    }
    Ok([
        FRAME_HEAD[0],
        FRAME_HEAD[1],
        FRAME_TYPE_BAR_STEREO_V1,
        left,
        right,
        FRAME_TYPE_BAR_STEREO_V1 ^ left ^ right,
    ])
}

pub fn parse_stereo_bar_frame(frame: &[u8]) -> Result<StereoBarFrame, ProtocolError> {
    if frame.len() != FRAME_LENGTH {
        return Err(ProtocolError::InvalidLength { actual: frame.len() });
    }
    if frame[0..2] != FRAME_HEAD {
        return Err(ProtocolError::InvalidHeader);
    }
    if frame[2] != FRAME_TYPE_BAR_STEREO_V1 {
        return Err(ProtocolError::InvalidType { actual: frame[2] });
    }
    if frame[3] > 8 || frame[4] > 8 {
        return Err(ProtocolError::InvalidBars {
            actual: frame[3].max(frame[4]),
        });
    }
    let expected = FRAME_TYPE_BAR_STEREO_V1 ^ frame[3] ^ frame[4];
    if frame[5] != expected {
        return Err(ProtocolError::InvalidChecksum {
            expected,
            actual: frame[5],
        });
    }
    Ok(StereoBarFrame {
        left: frame[3],
        right: frame[4],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_documented_frame() {
        assert_eq!(build_bar_frame(1, 3).unwrap(), [0xAA, 0x5A, 0x20, 0x01, 0x03, 0x22]);
    }

    #[test]
    fn accepts_zero_and_eight_bars() {
        assert_eq!(build_bar_frame(0, 0).unwrap()[4], 0);
        assert_eq!(build_bar_frame(255, 8).unwrap()[4], 8);
    }

    #[test]
    fn rejects_nine_bars() {
        assert_eq!(
            build_bar_frame(0, 9),
            Err(ProtocolError::InvalidBars { actual: 9 })
        );
    }

    #[test]
    fn parser_rejects_bad_checksum_without_accepting_frame() {
        let mut frame = build_bar_frame(1, 3).unwrap();
        frame[5] ^= 0x01;
        assert!(matches!(
            parse_bar_frame(&frame),
            Err(ProtocolError::InvalidChecksum { .. })
        ));
    }

    #[test]
    fn builds_stereo_frame_and_parses_back() {
        let frame = build_stereo_bar_frame(3, 7).unwrap();
        assert_eq!(frame, [0xAA, 0x5A, 0x26, 0x03, 0x07, 0x26 ^ 0x03 ^ 0x07]);
        assert_eq!(
            parse_stereo_bar_frame(&frame).unwrap(),
            StereoBarFrame { left: 3, right: 7 }
        );
    }

    #[test]
    fn rejects_stereo_levels_above_eight() {
        assert_eq!(
            build_stereo_bar_frame(9, 0),
            Err(ProtocolError::InvalidBars { actual: 9 })
        );
        assert_eq!(
            build_stereo_bar_frame(0, 9),
            Err(ProtocolError::InvalidBars { actual: 9 })
        );
    }
}
