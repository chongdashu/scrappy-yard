//! Small math helpers and a deterministic RNG shared by the simulation.
//!
//! Conventions (keep your asset contract the same): metres, +Y up, the ground is
//! the XZ plane, yaw 0 faces +Z and positive yaw turns counter-clockwise seen
//! from above, so facing = (sin yaw, 0, cos yaw).

pub const TAU: f32 = std::f32::consts::TAU;
pub const PI: f32 = std::f32::consts::PI;

#[inline]
pub fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    v.max(lo).min(hi)
}

#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Wrap an angle to (-PI, PI].
#[inline]
pub fn wrap_angle(a: f32) -> f32 {
    let mut a = a % TAU;
    if a > PI {
        a -= TAU;
    } else if a <= -PI {
        a += TAU;
    }
    a
}

/// Ground-plane direction for a yaw (yaw 0 faces +Z, counter-clockwise from above).
#[inline]
pub fn yaw_dir(yaw: f32) -> (f32, f32) {
    (yaw.sin(), yaw.cos())
}

/// Yaw of a ground-plane direction (inverse of `yaw_dir`).
#[inline]
pub fn yaw_of(x: f32, z: f32) -> f32 {
    x.atan2(z)
}

/// Move `from` toward `to` by at most `max_step` radians along the shorter arc.
#[inline]
pub fn turn_toward(from: f32, to: f32, max_step: f32) -> f32 {
    let d = wrap_angle(to - from);
    wrap_angle(from + clamp(d, -max_step, max_step))
}

/// Mix two u32s into a well-spread seed (e.g. game seed + round number).
#[inline]
pub fn mix_seed(a: u32, b: u32) -> u32 {
    let mut h = a ^ b.wrapping_mul(0x9e37_79b9);
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

/// Deterministic xorshift32 RNG (wasm32-unknown-unknown has no OS entropy,
/// and gameplay must replay identically from a seed anyway).
#[derive(Clone, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed.max(1))
    }
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    #[inline]
    pub fn f(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16_777_216.0
    }
    /// Uniform in [lo, hi).
    #[inline]
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f()
    }
    /// Uniform integer in [0, n) (n > 0).
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        ((self.next_u32() as u64 * n as u64) >> 32) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_angle_stays_in_range() {
        for i in -40..40 {
            let a = wrap_angle(i as f32 * 0.7);
            assert!(a > -PI - 1e-5 && a <= PI + 1e-5, "{a}");
        }
    }

    #[test]
    fn yaw_roundtrip_matches_the_asset_convention() {
        // yaw 0 faces +Z; +90° (CCW from above) faces +X.
        let (x, z) = yaw_dir(0.0);
        assert!(x.abs() < 1e-6 && (z - 1.0).abs() < 1e-6);
        let (x, z) = yaw_dir(PI / 2.0);
        assert!((x - 1.0).abs() < 1e-6 && z.abs() < 1e-6);
        for i in -6..6 {
            let yaw = i as f32 * 0.5;
            let (x, z) = yaw_dir(yaw);
            assert!(wrap_angle(yaw_of(x, z) - yaw).abs() < 1e-4);
        }
    }

    #[test]
    fn turn_toward_takes_the_short_way_and_stops_on_target() {
        let a = turn_toward(PI - 0.1, -PI + 0.1, 0.05);
        assert!(wrap_angle(a - (PI - 0.05)).abs() < 1e-4, "{a}");
        assert!((turn_toward(0.0, 0.3, 1.0) - 0.3).abs() < 1e-6);
    }

    #[test]
    fn rng_is_deterministic_and_in_range() {
        let (mut a, mut b) = (Rng::new(7), Rng::new(7));
        for _ in 0..1000 {
            let x = a.f();
            assert_eq!(x.to_bits(), b.f().to_bits());
            assert!((0.0..1.0).contains(&x));
            assert!(a.below(5) < 5);
            b.below(5);
        }
        assert_ne!(mix_seed(1, 0), mix_seed(1, 1));
    }
}
