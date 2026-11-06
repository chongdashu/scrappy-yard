//! Draw between fixed steps.
//!
//! The sim steps at a fixed 120 Hz, but the display rarely lines up with it.
//! A 120 Hz screen with jittery frame times alternates 0 and 2 steps per
//! frame, so anything drawn at the latest step visibly hitches, and a follow
//! camera hitches the whole screen. So keep each moving entity's pose from
//! before the latest step, and draw the blend toward the current pose by the
//! clock's leftover fraction (`FixedStep::alpha`). Gameplay, steering and
//! tests keep reading the current pose; the cost is up to one step (8.3 ms)
//! of display latency.
//!
//! Per moving entity: `snap` at the start of every fixed step and wherever it
//! is placed without moving (spawn, reset, teleport); `hold` before pausing;
//! write `render_pose(current, clock.alpha())` into the output buffer.

use crate::math::wrap_angle;

/// A pose on the ground plane: position and yaw (conventions in `math`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
}

impl Pose {
    pub const fn new(x: f32, z: f32, yaw: f32) -> Self {
        Pose { x, z, yaw }
    }

    /// `self` blended toward `to` by `t` (0..1); yaw takes the shorter arc.
    pub fn lerp(self, to: Pose, t: f32) -> Pose {
        Pose {
            x: self.x + (to.x - self.x) * t,
            z: self.z + (to.z - self.z) * t,
            yaw: wrap_angle(self.yaw + wrap_angle(to.yaw - self.yaw) * t),
        }
    }
}

/// The pose an entity had before the latest fixed step. The drawn pose blends
/// from it to the entity's current pose.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DrawnPose {
    pub prev: Pose,
}

impl DrawnPose {
    /// Start drawing at `current` (nothing to blend from).
    pub fn at(current: Pose) -> Self {
        DrawnPose { prev: current }
    }

    /// Remember `current` as the pose before the next step. Call at the start
    /// of every fixed step, and after placing the entity without moving it
    /// (spawn, reset, teleport) so it doesn't slide over from its old spot.
    pub fn snap(&mut self, current: Pose) {
        self.prev = current;
    }

    /// The pose to draw at `alpha` (0..1) of the way from the previous step to `current`.
    pub fn render_pose(&self, current: Pose, alpha: f32) -> Pose {
        self.prev.lerp(current, alpha.clamp(0.0, 1.0))
    }

    /// Pausing clears the clock's leftover fraction (a fraction of a step must
    /// not carry over a pause). Call this first, with the alpha still on
    /// screen, so the drawn pose freezes where it is instead of jumping back.
    pub fn hold(&mut self, current: Pose, alpha: f32) {
        self.prev = self.render_pose(current, alpha);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{FixedStep, DT};
    use crate::math::PI;

    /// Frame times of a 120 Hz display with ±1 ms timestamp jitter: the step
    /// rate equals the display rate, the worst case for fixed-step aliasing.
    fn jittery_120hz(frames: usize) -> Vec<f32> {
        const JITTER_MS: [f32; 10] = [0.0, 0.9, -0.8, 0.3, -0.95, 0.6, -0.2, 0.85, -0.7, 0.1];
        let mut prev = 0.0;
        let mut dts = Vec::with_capacity(frames);
        for k in 1..=frames {
            let t = k as f32 / 120.0 + JITTER_MS[k % JITTER_MS.len()] / 1000.0;
            dts.push(t - prev);
            prev = t;
        }
        dts
    }

    /// A body moving at a constant speed in fixed steps, drawn through DrawnPose.
    struct Mover {
        pose: Pose,
        drawn: DrawnPose,
        clock: FixedStep,
    }

    impl Mover {
        const SPEED: f32 = 4.5;
        fn frame(&mut self, dt: f32) -> (u32, Pose) {
            let n = self.clock.feed(dt);
            for _ in 0..n {
                self.drawn.snap(self.pose);
                self.pose.x += Self::SPEED * DT;
            }
            (n, self.drawn.render_pose(self.pose, self.clock.alpha()))
        }
    }

    #[test]
    fn drawn_pose_is_smooth_when_steps_alias() {
        let mut m = Mover { pose: Pose::default(), drawn: DrawnPose::default(), clock: FixedStep::default() };
        let (mut zero, mut double) = (0, 0);
        let mut last: Option<f32> = None;
        let mut worst: f32 = 0.0;
        for dt in jittery_120hz(240) {
            let (steps, drawn) = m.frame(dt);
            zero += (steps == 0) as u32;
            double += (steps == 2) as u32;
            if let Some(prev) = last {
                worst = worst.max(((drawn.x - prev) / dt / Mover::SPEED - 1.0).abs());
            }
            last = Some(drawn.x);
        }
        // The stepped pose really does hitch: some frames take no step, some two...
        assert!(zero > 3 && double > 3, "expected aliasing, got {zero} zero-step and {double} double-step frames");
        // ...but the drawn pose advances at the body's speed every frame.
        assert!(worst < 0.02, "drawn speed deviated {:.1}%", worst * 100.0);
    }

    #[test]
    fn render_pose_blends_position_and_takes_the_short_way_round() {
        let d = DrawnPose::at(Pose::new(0.0, 0.0, PI - 0.1));
        let p = d.render_pose(Pose::new(2.0, -4.0, -PI + 0.1), 0.5);
        assert!((p.x - 1.0).abs() < 1e-6 && (p.z + 2.0).abs() < 1e-6);
        // Halfway across ±PI is PI itself, not 0.
        assert!(wrap_angle(p.yaw - PI).abs() < 1e-4, "yaw {}", p.yaw);
        // Alpha is clamped to the two poses.
        assert_eq!(d.render_pose(Pose::new(2.0, 0.0, PI - 0.1), 3.0).x, 2.0);
    }

    #[test]
    fn snap_places_without_blending_from_the_old_spot() {
        let mut d = DrawnPose::at(Pose::new(5.0, 5.0, 0.0));
        let spawn = Pose::new(-3.0, 8.0, PI);
        d.snap(spawn);
        assert_eq!(d.render_pose(spawn, 0.0), spawn);
        assert_eq!(d.render_pose(spawn, 0.7), spawn);
    }

    #[test]
    fn hold_freezes_the_pose_on_screen() {
        let mut d = DrawnPose::at(Pose::new(0.0, 0.0, 0.0));
        let current = Pose::new(1.0, 0.0, 0.0);
        let shown = d.render_pose(current, 0.4);
        d.hold(current, 0.4);
        // Paused: the clock's fraction is cleared to 0, and the pose must not jump back.
        assert_eq!(d.render_pose(current, 0.0), shown);
    }
}
