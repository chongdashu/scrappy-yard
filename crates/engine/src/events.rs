//! Gameplay events as flat f32 records, read by JavaScript once per frame.
//!
//! Each record is `EVENT_FLOATS` floats: `[kind, a, b, c, d, e]`. Kinds and
//! the meaning of a..e belong to the game: its world module lists them and
//! its `src/sim-abi.ts` mirrors them. Events accumulate across the fixed steps
//! of one `sim_advance` call and stay readable until `sim_clear_frame`.

pub const EVENT_FLOATS: usize = 6;
/// Records kept per frame; later ones are dropped (and counted).
pub const EVENT_CAP: usize = 256;

#[derive(Clone, Debug)]
pub struct Events {
    pub buf: Vec<f32>,
    pub dropped: u32,
}

impl Default for Events {
    fn default() -> Self {
        Events { buf: Vec::with_capacity(EVENT_CAP * EVENT_FLOATS), dropped: 0 }
    }
}

impl Events {
    pub fn emit(&mut self, kind: f32, a: f32, b: f32, c: f32, d: f32, e: f32) {
        if self.buf.len() < EVENT_CAP * EVENT_FLOATS {
            self.buf.extend_from_slice(&[kind, a, b, c, d, e]);
        } else {
            self.dropped += 1;
        }
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }

    pub fn len(&self) -> usize {
        self.buf.len() / EVENT_FLOATS
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Records as slices (tests and debugging).
    pub fn records(&self) -> impl Iterator<Item = &[f32]> {
        self.buf.chunks_exact(EVENT_FLOATS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_are_flat_and_capped() {
        let mut ev = Events::default();
        for i in 0..(EVENT_CAP + 5) {
            ev.emit(1.0, i as f32, 0.0, 0.0, 0.0, 0.0);
        }
        assert_eq!(ev.len(), EVENT_CAP);
        assert_eq!(ev.dropped, 5);
        assert_eq!(ev.records().nth(3).unwrap()[1], 3.0);
        ev.clear();
        assert!(ev.is_empty());
    }
}
