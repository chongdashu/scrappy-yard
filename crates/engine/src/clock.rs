//! Fixed-step clock. The browser calls `sim_advance(real_dt)` once per
//! rendered frame; the simulation always steps in whole `DT` increments so
//! results don't depend on frame rate, and a long hitch (a background tab, a
//! breakpoint) is clamped instead of fast-forwarding the game.

/// Simulation rate. Every gameplay rule is written against this step.
pub const SIM_HZ: f32 = 120.0;
pub const DT: f32 = 1.0 / SIM_HZ;
/// Longest real frame accepted per call (s). Anything longer is dropped.
pub const MAX_FRAME: f32 = 0.1;
/// Most fixed steps one call may run (MAX_FRAME / DT = 12).
pub const MAX_STEPS: u32 = 12;

#[derive(Clone, Debug, Default)]
pub struct FixedStep {
    accum: f32,
}

impl FixedStep {
    /// Feed real elapsed time; returns how many fixed steps to run now.
    /// Negative/NaN input counts as zero.
    pub fn feed(&mut self, real_dt: f32) -> u32 {
        let dt = if real_dt.is_finite() { real_dt.clamp(0.0, MAX_FRAME) } else { 0.0 };
        self.accum += dt;
        let mut n = 0;
        // A tiny epsilon keeps 1/60 s frames from alternating 1 and 3 steps
        // through float rounding.
        while self.accum + 1e-6 >= DT && n < MAX_STEPS {
            self.accum -= DT;
            n += 1;
        }
        if n == MAX_STEPS {
            self.accum = self.accum.min(DT);
        }
        self.accum = self.accum.max(0.0);
        n
    }

    pub fn clear(&mut self) {
        self.accum = 0.0;
    }

    /// How far real time has run into the next step, 0..1. Presentation draws
    /// `prev + (current - prev) * alpha` so motion stays smooth when the
    /// display rate and the step rate don't line up (e.g. a 120 Hz display
    /// with jittery frame times alternating 0 and 2 steps per frame).
    pub fn alpha(&self) -> f32 {
        (self.accum / DT).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_is_the_leftover_fraction_of_a_step() {
        let mut c = FixedStep::default();
        assert_eq!(c.feed(DT * 0.25), 0);
        assert!((c.alpha() - 0.25).abs() < 1e-4);
        assert_eq!(c.feed(DT), 1);
        assert!((c.alpha() - 0.25).abs() < 1e-3);
        c.clear();
        assert_eq!(c.alpha(), 0.0);
    }

    #[test]
    fn sixty_hz_frames_run_two_steps_each() {
        let mut c = FixedStep::default();
        for _ in 0..600 {
            assert_eq!(c.feed(1.0 / 60.0), 2);
        }
    }

    #[test]
    fn hitches_are_clamped_and_capped() {
        let mut c = FixedStep::default();
        assert_eq!(c.feed(5.0), MAX_STEPS);
        // The clamped remainder doesn't snowball into the next frame.
        assert!(c.feed(0.0) <= 1);
        assert_eq!(c.feed(-1.0), 0);
        assert_eq!(c.feed(f32::NAN), 0);
    }

    #[test]
    fn short_frames_accumulate() {
        let mut c = FixedStep::default();
        let mut total = 0;
        for _ in 0..240 {
            total += c.feed(1.0 / 240.0);
        }
        assert_eq!(total, 120);
    }
}
