//! The scrapyard greybox gym (kickoff): an oncoming three-lane runner. The
//! player runs toward +Z (toward the camera), strafes freely across the deck
//! (hazards still sit in three lanes), jumps barrels
//! and gaps, collects hex nuts and stays ahead of a junk mech that closes in
//! from behind (−Z). Placeholder rules for de-risking the mechanic; the
//! vertical slice replaces the tuning, not the shape.
//!
//! Rust owns every gameplay value; JS only reads the output buffers and
//! sends input: a held strafe axis (`sim_strafe`), lane nudges (`sim_lane`)
//! and jumps (`sim_jump`). Moving things keep the pose
//! they had before the latest step, and the buffers carry the drawn
//! (interpolated) pose alongside the current one.
//!
//! Conventions (docs/asset-contract.md): metres, +Y up, the run direction and
//! every character's front is +Z. Lanes are −1, 0, +1 at x = lane × LANE_WIDTH;
//! the oncoming camera looks toward −Z, so screen-left is −X.
//!
//! Movement is continuous, collisions are lane-based: the player's x is free
//! within ±(LANE_WIDTH + STRAFE_MARGIN), and `player.lane` is the nearest lane
//! to x (the logical lane for warnings). A barrel, car or nut hits whenever
//! the player is inside its lane corridor: |x − lane_x| < max(physical overlap,
//! LANE_WIDTH / 2), so the nearest lane's hazards always count and straddling
//! the line between two lanes meets both.

use vgd_engine::clock::{FixedStep, DT};
use vgd_engine::events::Events;
use vgd_engine::math::{clamp, lerp, mix_seed, Rng};
use vgd_engine::Sim;

use crate::params::{self, *};

// ---------------------------------------------------------------- ABI layout

/// Bump when any export, stride, index or event meaning below changes;
/// `game/src/sim-abi.ts` must carry the same number (checked at boot).
pub const ABI_VERSION: u32 = 3;

/// Stats record.
pub const STATS_FLOATS: usize = 15;
pub const ST_TIME: usize = 0;
pub const ST_ROUND_TIME: usize = 1;
pub const ST_STATE: usize = 2;
pub const ST_PAUSED: usize = 3;
pub const ST_ROUND: usize = 4;
pub const ST_STEPS: usize = 5;
pub const ST_NUTS: usize = 6;
pub const ST_NUTS_TOTAL: usize = 7;
pub const ST_DISTANCE: usize = 8;
pub const ST_COURSE: usize = 9;
pub const ST_LOSE_REASON: usize = 10;
pub const ST_MECH_GAP: usize = 11;
pub const ST_PRACTICE: usize = 12;
pub const ST_STUMBLES: usize = 13;
pub const ST_MODE: usize = 14;

/// Player record: current pose, drawn pose and state.
pub const PLAYER_FLOATS: usize = 14;
pub const PL_X: usize = 0;
pub const PL_Y: usize = 1;
pub const PL_Z: usize = 2;
pub const PL_RX: usize = 3;
pub const PL_RY: usize = 4;
pub const PL_RZ: usize = 5;
pub const PL_LANE: usize = 6;
pub const PL_GROUNDED: usize = 7;
pub const PL_STUMBLE: usize = 8;
pub const PL_VY: usize = 9;
pub const PL_GAP: usize = 10;
pub const PL_RGAP: usize = 11;
pub const PL_FALLING: usize = 12;
pub const PL_SPEED: usize = 13;

/// Obstacle record: kind, lane, z (centre), half length (z), height, hit.
pub const OBSTACLE_FLOATS: usize = 6;
/// Nut record: x, y, z, collected.
pub const NUT_FLOATS: usize = 4;

pub const STATE_READY: u8 = 0;
pub const STATE_PLAYING: u8 = 1;
pub const STATE_WON: u8 = 2;
pub const STATE_LOST: u8 = 3;

pub const LOSE_NONE: u8 = 0;
pub const LOSE_CRASH: u8 = 1;
pub const LOSE_FALL: u8 = 2;
pub const LOSE_CAUGHT: u8 = 3;

pub const OB_BARREL: u8 = 1;
pub const OB_CAR: u8 = 2;
pub const OB_GAP: u8 = 3;

/// Collision half-widths (x) per kind and the player's half-depth (z).
pub const BARREL_HALF_W: f32 = 0.42;
pub const BARREL_HALF_L: f32 = 0.35;
pub const BARREL_HEIGHT: f32 = 0.8;
pub const CAR_HALF_W: f32 = 0.6;
pub const CAR_HALF_L: f32 = 1.5;
pub const CAR_HEIGHT: f32 = 1.4;
pub const GAP_HALF_L: f32 = 1.5;
pub const PLAYER_HALF_L: f32 = 0.2;
/// Nut pickup half-width (x) at the least; widened to the lane corridor (half a lane + 0.05).
pub const NUT_HALF_W: f32 = 0.55;
/// Mech surge strength 0..1 at course z: after the first 40 m, a 32 m sine bump every `every` m
/// (the TS side mirrors this as `surgeAt` for the roar / pop at a surge's start).
pub fn surge_at(z: f32, every: f32) -> f32 {
    const LEAD: f32 = 40.0;
    const LEN: f32 = 32.0;
    if every <= 0.0 || z < LEAD {
        return 0.0;
    }
    let ph = (z - LEAD) % every.max(LEN);
    if ph < LEN { (core::f32::consts::PI * ph / LEN).sin() } else { 0.0 }
}

/// The floor is missing only this far inside a gap's edges (a forgiving lip).
pub const GAP_LIP: f32 = 0.1;
/// Below this height over a gap the player is in the hole and cannot land.
pub const FALL_COMMIT_Y: f32 = -0.25;
/// Falling this far ends the run.
pub const FALL_DEAD_Y: f32 = -2.0;

/// Round started: a = round number, b = nuts total, c = course length.
pub const EV_ROUND_START: f32 = 1.0;
/// Nut collected: a index, b x, c y, d z, e collected so far.
pub const EV_NUT: f32 = 2.0;
/// Stumble: a x, b z, c obstacle kind, d mech gap after.
pub const EV_STUMBLE: f32 = 3.0;
/// Jump: a x, b z.
pub const EV_JUMP: f32 = 4.0;
/// Land: a x, b z, c impact speed.
pub const EV_LAND: f32 = 5.0;
/// Nearest (logical) lane changed while strafing or nudging: a new lane, b direction.
pub const EV_LANE: f32 = 6.0;
/// Won: a round time, b nuts, c nuts total.
pub const EV_WIN: f32 = 7.0;
/// Lost: a reason, b z, c nuts.
pub const EV_LOSE: f32 = 8.0;

pub const MODE_GYM: u8 = 0;
/// Asset viewer: the sim keeps its clock but runs no rules (nothing moves or ends).
pub const MODE_VIEWER: u8 = 1;

// ---------------------------------------------------------------- state

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Obstacle {
    pub kind: u8,
    pub lane: i8,
    pub z: f32,
    pub half_l: f32,
    pub height: f32,
    pub hit: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Nut {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub collected: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Player {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vy: f32,
    pub lane: i8,
    pub grounded: bool,
    pub falling: bool,
    pub stumble: f32,
    pub coyote: f32,
    pub jump_buffer: f32,
    pub speed: f32,
    /// Metres between the player and the mech (mech z = z − gap).
    pub gap: f32,
    /// Sideways speed (m/s, +X).
    pub vx: f32,
    /// Held strafe axis −1..1 from input (0 = released).
    pub strafe: f32,
    /// A lane nudge's target x, until reached or overridden by a held strafe.
    pub nudge: Option<f32>,
}

pub struct World {
    pub p: [f32; params::COUNT],
    pub seed: u32,
    pub round: u32,
    pub rng: Rng,
    pub clock: FixedStep,
    pub events: Events,
    pub paused: bool,
    pub state: u8,
    pub mode: u8,
    pub lose_reason: u8,
    pub time: f32,
    pub round_time: f32,
    pub steps: u32,
    pub player: Player,
    /// Player x, y, z and mech gap before the latest step (the drawn pose blends from it).
    pub prev: [f32; 4],
    pub obstacles: Vec<Obstacle>,
    pub nuts: Vec<Nut>,
    pub collected: u32,
    pub stumbles: u32,
    pub course: f32,
    pub out_stats: [f32; STATS_FLOATS],
    pub out_player: [f32; PLAYER_FLOATS],
    pub out_obstacles: Vec<f32>,
    pub out_nuts: Vec<f32>,
}

impl World {
    pub fn new(seed: u32) -> Self {
        let mut w = World {
            p: DEFAULTS,
            seed,
            round: 0,
            rng: Rng::new(seed),
            clock: FixedStep::default(),
            events: Events::default(),
            paused: false,
            state: STATE_READY,
            mode: MODE_GYM,
            lose_reason: LOSE_NONE,
            time: 0.0,
            round_time: 0.0,
            steps: 0,
            player: Player::default(),
            prev: [0.0; 4],
            obstacles: Vec::new(),
            nuts: Vec::new(),
            collected: 0,
            stumbles: 0,
            course: DEFAULTS[COURSE_LENGTH],
            out_stats: [0.0; STATS_FLOATS],
            out_player: [0.0; PLAYER_FLOATS],
            out_obstacles: Vec::new(),
            out_nuts: Vec::new(),
        };
        w.reset();
        w
    }

    pub fn lane_x(&self, lane: i8) -> f32 {
        lane as f32 * self.p[LANE_WIDTH]
    }

    /// Back to a fresh round, READY, with a newly laid-out course. Params are kept.
    pub fn reset(&mut self) {
        self.rng = Rng::new(mix_seed(self.seed, self.round));
        self.round = self.round.wrapping_add(1);
        self.clock.clear();
        self.events.clear();
        self.paused = false;
        self.state = STATE_READY;
        self.lose_reason = LOSE_NONE;
        self.time = 0.0;
        self.round_time = 0.0;
        self.steps = 0;
        self.collected = 0;
        self.stumbles = 0;
        self.course = self.p[COURSE_LENGTH].max(40.0);
        self.player = Player { grounded: true, gap: self.p[MECH_GAP_START], speed: 0.0, ..Player::default() };
        self.snap();
        self.build_course();
        self.write_outputs();
    }

    /// Deterministic course from the round's RNG: a clear 30 m run-up, then a
    /// pattern every 16–22 m, always leaving a way through.
    pub fn build_course(&mut self) {
        self.obstacles.clear();
        self.nuts.clear();
        let end = self.course - 25.0;
        let mut z = 32.0;
        while z < end {
            let a = self.rng.below(3) as i8 - 1;
            let b = (a + 1 + self.rng.below(2) as i8 + 1).rem_euclid(3) - 1; // a lane other than a
            let c = 0 - a - b; // the remaining lane
            match self.rng.below(6) {
                0 => {
                    self.barrel(a, z);
                    self.nut_line(b, z - 3.0, 4, 2.0);
                }
                1 => {
                    self.car(a, z);
                    self.car(b, z);
                    self.nut_line(c, z - 4.0, 5, 2.0);
                }
                2 => {
                    self.gap(z);
                    let x = self.lane_x(a);
                    for (dz, y) in [(-1.6, 1.2), (0.0, 1.8), (1.6, 1.2)] {
                        self.nuts.push(Nut { x, y, z: z + dz, collected: false });
                    }
                }
                3 => {
                    for l in -1..=1 {
                        self.barrel(l, z);
                    }
                    let x = self.lane_x(b);
                    self.nuts.push(Nut { x, y: 1.6, z, collected: false });
                }
                4 => {
                    self.car(a, z);
                    self.barrel(b, z);
                    self.nut_line(c, z - 3.0, 4, 2.0);
                }
                _ => {
                    for i in 0..6 {
                        let lane = [a, 0, -a, 0, a, 0][i];
                        let lane = if a == 0 { [-1, 0, 1, 0, -1, 0][i] } else { lane };
                        let x = self.lane_x(lane);
                        self.nuts.push(Nut { x, y: 0.6, z: z - 5.0 + i as f32 * 2.0, collected: false });
                    }
                }
            }
            z += 16.0 + self.rng.range(0.0, 6.0);
        }
        // A short line of nuts in the run-up shows the collect loop at once.
        for i in 0..4 {
            self.nuts.push(Nut { x: 0.0, y: 0.6, z: 12.0 + i as f32 * 2.0, collected: false });
        }
    }

    fn barrel(&mut self, lane: i8, z: f32) {
        self.obstacles.push(Obstacle { kind: OB_BARREL, lane, z, half_l: BARREL_HALF_L, height: BARREL_HEIGHT, hit: false });
    }
    fn car(&mut self, lane: i8, z: f32) {
        self.obstacles.push(Obstacle { kind: OB_CAR, lane, z, half_l: CAR_HALF_L, height: CAR_HEIGHT, hit: false });
    }
    fn gap(&mut self, z: f32) {
        self.obstacles.push(Obstacle { kind: OB_GAP, lane: 0, z, half_l: GAP_HALF_L, height: 0.0, hit: false });
    }
    fn nut_line(&mut self, lane: i8, z0: f32, n: usize, step: f32) {
        let x = self.lane_x(lane);
        for i in 0..n {
            self.nuts.push(Nut { x, y: 0.6, z: z0 + i as f32 * step, collected: false });
        }
    }

    /// Is there floor under this z (no gap)?
    pub fn floor_at(&self, z: f32) -> bool {
        !self.obstacles.iter().any(|o| o.kind == OB_GAP && (z - o.z).abs() < o.half_l - GAP_LIP)
    }

    pub fn round_start(&mut self) {
        if self.state != STATE_READY {
            return;
        }
        self.state = STATE_PLAYING;
        self.events.emit(EV_ROUND_START, self.round as f32, self.nuts.len() as f32, self.course, 0.0, 0.0);
        self.write_outputs();
    }

    pub fn set_mode(&mut self, mode: u8) {
        self.mode = mode;
        self.write_outputs();
    }

    /// Half-width of the strip the player can strafe across (outer lane centre + margin).
    pub fn x_limit(&self) -> f32 {
        self.p[LANE_WIDTH] + self.p[STRAFE_MARGIN].max(0.0)
    }

    /// The nearest lane (−1, 0, +1) to an x: the logical lane for warnings.
    pub fn nearest_lane(&self, x: f32) -> i8 {
        (x / self.p[LANE_WIDTH].max(0.01)).round().clamp(-1.0, 1.0) as i8
    }

    /// A lane nudge (tap / flick): slide to the next lane centre left (−1) or right (+1) of
    /// where the player is, or of a nudge still in flight (two taps = two lanes). Ignored
    /// outside play.
    pub fn lane(&mut self, dir: i32) {
        if self.state != STATE_PLAYING || self.mode != MODE_GYM || dir == 0 {
            return;
        }
        let lw = self.p[LANE_WIDTH].max(0.01);
        let from = self.player.nudge.unwrap_or(self.player.x);
        let d = dir.signum() as f32;
        // The first lane centre at least a sliver beyond `from` in that direction.
        let next = if d > 0.0 { ((from + 0.15) / lw).floor() + 1.0 } else { ((from - 0.15) / lw).ceil() - 1.0 };
        self.player.nudge = Some(next.clamp(-1.0, 1.0) * lw);
    }

    /// The held sideways axis (−1..1, screen-left is −X). Ignored outside play.
    pub fn strafe(&mut self, axis: f32) {
        let a = if axis.is_finite() { axis.clamp(-1.0, 1.0) } else { 0.0 };
        self.player.strafe = if self.state == STATE_PLAYING && self.mode == MODE_GYM { a } else { 0.0 };
    }

    /// A jump press: buffered for `JUMP_BUFFER` s until the floor (or coyote time) allows it.
    pub fn jump(&mut self) {
        if self.state == STATE_PLAYING && self.mode == MODE_GYM {
            self.player.jump_buffer = self.p[JUMP_BUFFER];
        }
    }

    pub fn advance(&mut self, real_dt: f32) -> u32 {
        if self.paused {
            return 0;
        }
        let n = self.clock.feed(real_dt);
        for _ in 0..n {
            self.step();
        }
        self.write_outputs();
        n
    }

    pub fn set_paused(&mut self, on: bool) {
        if on {
            // Freeze the drawn pose where it is on screen before the leftover fraction is dropped.
            let a = self.clock.alpha();
            let pl = self.player;
            let cur = [pl.x, pl.y, pl.z, pl.gap];
            for i in 0..4 {
                self.prev[i] = lerp(self.prev[i], cur[i], a);
            }
            self.clock.clear();
        }
        self.paused = on;
        self.write_outputs();
    }

    fn snap(&mut self) {
        let pl = self.player;
        self.prev = [pl.x, pl.y, pl.z, pl.gap];
    }

    fn lose(&mut self, reason: u8) {
        self.state = STATE_LOST;
        self.lose_reason = reason;
        self.events.emit(EV_LOSE, reason as f32, self.player.z, self.collected as f32, 0.0, 0.0);
    }

    fn stumble(&mut self, kind: u8) {
        self.player.stumble = self.p[STUMBLE_TIME];
        self.stumbles += 1;
        self.events.emit(EV_STUMBLE, self.player.x, self.player.z, kind as f32, self.player.gap, 0.0);
    }

    pub fn step(&mut self) {
        self.time += DT;
        self.steps = self.steps.wrapping_add(1);
        self.snap();
        if self.state != STATE_PLAYING || self.mode != MODE_GYM {
            return;
        }
        self.round_time += DT;
        let p = self.p;
        let practice = p[PRACTICE] > 0.5;

        // Forward run.
        let pl = &mut self.player;
        pl.stumble = (pl.stumble - DT).max(0.0);
        pl.jump_buffer = (pl.jump_buffer - DT).max(0.0);
        pl.coyote = (pl.coyote - DT).max(0.0);
        pl.speed = p[RUN_SPEED] * if pl.stumble > 0.0 { p[STUMBLE_SPEED] } else { 1.0 };
        pl.z += pl.speed * DT;

        // Sideways: a held strafe accelerates toward STRAFE_SPEED (and cancels a nudge); a
        // nudge slides at the lane-switch speed to its lane centre; with neither the player
        // brakes to a stop where it is (no snap to a lane).
        let limit = p[LANE_WIDTH] + p[STRAFE_MARGIN].max(0.0);
        if pl.strafe.abs() > 0.01 {
            pl.nudge = None;
            let target = pl.strafe * p[STRAFE_SPEED];
            // Braking or reversing bites harder than speeding up.
            let acc = if target * pl.vx < 0.0 || target.abs() < pl.vx.abs() { 1.5 } else { 1.0 } * p[STRAFE_ACCEL];
            pl.vx += clamp(target - pl.vx, -acc * DT, acc * DT);
            pl.x += pl.vx * DT;
        } else if let Some(tx) = pl.nudge {
            let max = p[LANE_WIDTH] / p[LANE_SWITCH_TIME].max(0.02) * DT;
            let dx = clamp(tx - pl.x, -max, max);
            pl.x += dx;
            pl.vx = dx / DT;
            if (tx - pl.x).abs() < 1e-4 {
                pl.x = tx;
                pl.nudge = None;
                pl.vx = 0.0;
            }
        } else {
            let brake = 1.5 * p[STRAFE_ACCEL] * DT;
            pl.vx -= clamp(pl.vx, -brake, brake);
            pl.x += pl.vx * DT;
        }
        if pl.x.abs() > limit {
            pl.x = clamp(pl.x, -limit, limit);
            pl.vx = 0.0;
        }
        let lane = (pl.x / p[LANE_WIDTH].max(0.01)).round().clamp(-1.0, 1.0) as i8;
        if lane != pl.lane {
            let dir = (lane - pl.lane).signum();
            pl.lane = lane;
            self.events.emit(EV_LANE, lane as f32, dir as f32, 0.0, 0.0, 0.0);
        }

        // Vertical: floor, coyote time, buffered jump, gravity, landing.
        let (z, x) = (pl.z, pl.x);
        let floor = self.floor_at(z);
        let pl = &mut self.player;
        if pl.grounded && !floor {
            pl.grounded = false;
            pl.coyote = p[COYOTE_TIME];
        }
        if pl.jump_buffer > 0.0 && !pl.falling && (pl.grounded || pl.coyote > 0.0) {
            pl.vy = p[JUMP_SPEED];
            pl.grounded = false;
            pl.coyote = 0.0;
            pl.jump_buffer = 0.0;
            self.events.emit(EV_JUMP, x, z, 0.0, 0.0, 0.0);
        }
        let pl = &mut self.player;
        if !pl.grounded {
            pl.vy -= p[GRAVITY] * DT;
            pl.y += pl.vy * DT;
            if pl.y <= 0.0 && floor && !pl.falling && pl.y > FALL_COMMIT_Y {
                let impact = -pl.vy;
                pl.y = 0.0;
                pl.vy = 0.0;
                pl.grounded = true;
                self.events.emit(EV_LAND, x, z, impact, 0.0, 0.0);
            } else if pl.y < FALL_COMMIT_Y && !floor {
                pl.falling = true;
            }
        }
        if self.player.falling && self.player.y < FALL_DEAD_Y {
            if practice {
                let pl = &mut self.player;
                // Pop back up past the hole so the gym keeps running.
                pl.y = 0.0;
                pl.vy = 0.0;
                pl.falling = false;
                pl.grounded = true;
                if let Some(o) = self.obstacles.iter().find(|o| o.kind == OB_GAP && (z - o.z).abs() < o.half_l + 1.0) {
                    self.player.z = o.z + o.half_l + 0.2;
                }
                self.stumble(OB_GAP);
            } else {
                self.lose(LOSE_FALL);
                return;
            }
        }

        // Barrels and cars.
        let (px, py, pz) = (self.player.x, self.player.y, self.player.z);
        let lw = p[LANE_WIDTH];
        let mut hit: Option<(usize, u8)> = None;
        for (i, o) in self.obstacles.iter().enumerate() {
            if o.hit || o.kind == OB_GAP {
                continue;
            }
            let half_w = if o.kind == OB_CAR { CAR_HALF_W } else { BARREL_HALF_W };
            // Lane corridor: the physical overlap, but never narrower than half a lane, so the
            // nearest lane's hazard always hits wherever in the lane the player is.
            let window = (p[PLAYER_HALF_WIDTH] + half_w).max(lw * 0.5);
            if (px - o.lane as f32 * lw).abs() < window
                && (pz - o.z).abs() < PLAYER_HALF_L + o.half_l
                && py < o.height
                && py + p[PLAYER_HEIGHT] > 0.0
            {
                hit = Some((i, o.kind));
                break;
            }
        }
        if let Some((i, kind)) = hit {
            self.obstacles[i].hit = true;
            if kind == OB_CAR && !practice {
                self.lose(LOSE_CRASH);
                return;
            }
            self.stumble(kind);
        }

        // Nuts: collected anywhere in their lane (half a lane, plus a sliver so the line
        // between two lanes picks up both).
        let nut_w = NUT_HALF_W.max(lw * 0.5 + 0.05);
        for i in 0..self.nuts.len() {
            let n = self.nuts[i];
            if !n.collected && (px - n.x).abs() < nut_w && (pz - n.z).abs() < 0.6 && (n.y - (py + 0.55)).abs() < 0.85 {
                self.nuts[i].collected = true;
                self.collected += 1;
                self.events.emit(EV_NUT, i as f32, n.x, n.y, n.z, self.collected as f32);
            }
        }

        // Chase pressure: the mech runs at full speed and holds a comfort gap
        // that shrinks along the course; every slow-down hands it ground.
        let progress = clamp(pz / self.course, 0.0, 1.0);
        // Surges: every SURGE_EVERY m the comfort gap dips by up to SURGE_DEPTH (never under 5 m)
        // and the mech closes at SURGE_RATE, then the gap eases back: pressure rises and falls.
        let surge = surge_at(pz, p[SURGE_EVERY]);
        let base = lerp(p[MECH_GAP_START], p[MECH_GAP_END], progress);
        let comfort = (base - surge * p[SURGE_DEPTH]).min(base).max(base.min(5.0));
        let close = if surge > 0.0 { p[SURGE_RATE].max(p[MECH_RECOVER]) } else { p[MECH_RECOVER] };
        let pl = &mut self.player;
        let lost = p[RUN_SPEED] - pl.speed;
        if lost > 0.0 {
            pl.gap -= lost * DT;
        } else if pl.gap < comfort {
            pl.gap = (pl.gap + p[MECH_RECOVER] * DT).min(comfort);
        } else {
            pl.gap = (pl.gap - close * DT).max(comfort);
        }
        if pl.gap <= p[MECH_CATCH_GAP] {
            if practice {
                pl.gap = p[MECH_CATCH_GAP] + 0.05;
            } else {
                self.lose(LOSE_CAUGHT);
                return;
            }
        }

        if self.player.z >= self.course {
            self.state = STATE_WON;
            self.events.emit(EV_WIN, self.round_time, self.collected as f32, self.nuts.len() as f32, 0.0, 0.0);
        }
    }

    pub fn write_outputs(&mut self) {
        let a = self.clock.alpha();
        let pl = self.player;
        let r = |i: usize, cur: f32| lerp(self.prev[i], cur, a);
        self.out_player = [
            pl.x, pl.y, pl.z,
            r(0, pl.x), r(1, pl.y), r(2, pl.z),
            pl.lane as f32, pl.grounded as u8 as f32,
            if self.p[STUMBLE_TIME] > 0.0 { pl.stumble / self.p[STUMBLE_TIME] } else { 0.0 },
            pl.vy, pl.gap, r(3, pl.gap), pl.falling as u8 as f32, pl.speed,
        ];
        self.out_stats = [
            self.time, self.round_time, self.state as f32, self.paused as u8 as f32, self.round as f32, self.steps as f32,
            self.collected as f32, self.nuts.len() as f32, pl.z, self.course, self.lose_reason as f32, pl.gap,
            self.p[PRACTICE], self.stumbles as f32, self.mode as f32,
        ];
        self.out_obstacles.clear();
        for o in &self.obstacles {
            self.out_obstacles.extend_from_slice(&[o.kind as f32, o.lane as f32, o.z, o.half_l, o.height, o.hit as u8 as f32]);
        }
        self.out_nuts.clear();
        for n in &self.nuts {
            self.out_nuts.extend_from_slice(&[n.x, n.y, n.z, n.collected as u8 as f32]);
        }
    }
}

impl Sim for World {
    const ABI_VERSION: u32 = ABI_VERSION;
    const PARAM_DEFAULTS: &'static [f32] = &DEFAULTS;

    fn new(seed: u32) -> Self {
        World::new(seed)
    }
    fn reset(&mut self) {
        World::reset(self);
    }
    fn advance(&mut self, real_dt: f32) -> u32 {
        World::advance(self, real_dt)
    }
    fn set_paused(&mut self, on: bool) {
        World::set_paused(self, on);
    }
    fn round_start(&mut self) {
        World::round_start(self);
    }
    fn params(&mut self) -> &mut [f32] {
        &mut self.p
    }
    fn events(&mut self) -> &mut Events {
        &mut self.events
    }
    fn params_changed(&mut self) {
        self.write_outputs();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(w: &mut World, seconds: f32) -> u32 {
        (0..(seconds * 60.0).round() as usize).map(|_| w.advance(1.0 / 60.0)).sum()
    }

    /// A world with an empty course (tests place their own obstacles), playing.
    fn empty(seed: u32) -> World {
        let mut w = World::new(seed);
        w.obstacles.clear();
        w.nuts.clear();
        w.round_start();
        w.events.clear();
        w
    }

    fn kinds(w: &World) -> Vec<f32> {
        w.events.records().map(|r| r[0]).collect()
    }

    #[test]
    fn ready_round_keeps_still_until_started() {
        let mut w = World::new(1);
        run(&mut w, 0.5);
        assert_eq!((w.state, w.player.z, w.round_time), (STATE_READY, 0.0, 0.0));
        w.round_start();
        run(&mut w, 1.0);
        assert!((w.player.z - w.p[RUN_SPEED]).abs() < 0.05, "{}", w.player.z);
        assert_eq!(w.out_stats[ST_STATE], STATE_PLAYING as f32);
    }

    #[test]
    fn lane_nudges_clamp_and_slide_to_the_lane_centre() {
        let mut w = empty(1);
        w.lane(-1);
        w.lane(-1);
        run(&mut w, 0.3);
        assert_eq!(w.player.lane, -1);
        assert!((w.player.x + w.p[LANE_WIDTH]).abs() < 1e-4, "{}", w.player.x);
        w.lane(1);
        w.lane(1);
        w.lane(1);
        run(&mut w, 0.5);
        assert_eq!(w.player.lane, 1);
        assert!((w.player.x - w.p[LANE_WIDTH]).abs() < 1e-4);
        assert_eq!(kinds(&w).iter().filter(|k| **k == EV_LANE).count(), 3);
    }

    #[test]
    fn a_held_strafe_slides_freely_and_stops_where_released() {
        let mut w = empty(1);
        let lw = w.p[LANE_WIDTH];
        w.strafe(1.0);
        run(&mut w, 0.15);
        w.strafe(0.0);
        run(&mut w, 0.3);
        let x = w.player.x;
        // Stopped between lane centres: no snap to a lane.
        assert!(x > 0.2 && x < lw - 0.2, "x {x}");
        assert_eq!(w.player.vx, 0.0);
        run(&mut w, 0.5);
        assert_eq!(w.player.x, x, "stays put once released");
        assert_eq!(w.player.lane, w.nearest_lane(x));
        // Held long, it crosses lanes and stops at the deck edge (past the outer lane centre).
        w.strafe(-1.0);
        run(&mut w, 1.5);
        assert!((w.player.x + w.x_limit()).abs() < 1e-4 && w.x_limit() > lw, "{}", w.player.x);
        assert_eq!(w.player.lane, -1);
        let lanes: Vec<f32> = w.events.records().filter(|r| r[0] == EV_LANE).map(|r| r[1]).collect();
        assert!(lanes.ends_with(&[0.0, -1.0]), "{lanes:?}");
    }

    #[test]
    fn a_held_strafe_overrides_a_nudge() {
        let mut w = empty(1);
        w.lane(1);
        w.strafe(-1.0);
        run(&mut w, 0.3);
        assert!(w.player.x < 0.0 && w.player.nudge.is_none(), "{}", w.player.x);
    }

    /// Strafe to a fixed x (practice keeps the run going) and run into lane `lane`'s barrel.
    fn barrel_at(x: f32, lane: i8) -> u32 {
        let mut w = empty(1);
        w.p[PRACTICE] = 1.0;
        w.player.x = x;
        w.barrel(lane, 4.0);
        run(&mut w, 1.0);
        w.stumbles
    }

    #[test]
    fn hazards_hit_anywhere_in_their_lane_corridor() {
        let lw = DEFAULTS[LANE_WIDTH];
        // Off-centre but nearest to the barrel's lane: hits.
        assert_eq!(barrel_at(lw * 0.45, 0), 1);
        assert_eq!(barrel_at(lw * 0.55, 1), 1);
        assert_eq!(barrel_at(-lw * 1.3, -1), 1);
        // Straddling the line between lanes 0 and 1: both lanes' barrels count.
        assert_eq!(barrel_at(lw * 0.5, 0), 1);
        assert_eq!(barrel_at(lw * 0.5, 1), 1);
        // Well inside the next lane: clear.
        assert_eq!(barrel_at(lw * 0.8, 0), 0);
        assert_eq!(barrel_at(-lw * 0.8, 0), 0);

        // A car in lane 0 misses a player strafed most of the way into lane 1.
        let mut w = empty(1);
        w.player.x = lw * 0.75;
        w.car(0, 5.0);
        run(&mut w, 1.5);
        assert_eq!((w.state, w.stumbles), (STATE_PLAYING, 0));

        // Nuts collect off-centre in their lane.
        let mut w = empty(1);
        w.player.x = lw * 0.6;
        w.nut_line(1, 3.0, 3, 2.0);
        w.nut_line(-1, 3.0, 3, 2.0);
        run(&mut w, 1.5);
        assert_eq!(w.collected, 3);

        // A gap spans every lane: it kills wherever the player strafes.
        let mut w = empty(1);
        w.player.x = lw * 1.3;
        w.gap(6.0);
        run(&mut w, 2.0);
        assert_eq!((w.state, w.lose_reason), (STATE_LOST, LOSE_FALL));
    }

    #[test]
    fn a_jump_clears_a_barrel_and_lands() {
        let mut w = empty(1);
        // Barrel 6 m ahead; jump ~2.5 m before it.
        w.barrel(0, 6.0);
        run(&mut w, 3.5 / 8.0);
        w.jump();
        run(&mut w, 1.5);
        assert_eq!(w.stumbles, 0, "cleared the barrel");
        assert!(w.player.grounded && w.player.y == 0.0);
        let k = kinds(&w);
        assert!(k.contains(&EV_JUMP) && k.contains(&EV_LAND), "{k:?}");
    }

    #[test]
    fn a_barrel_stumbles_and_hands_the_mech_ground() {
        let mut w = empty(1);
        w.barrel(0, 4.0);
        let gap0 = w.player.gap;
        run(&mut w, 1.5);
        assert_eq!((w.stumbles, w.state), (1, STATE_PLAYING));
        assert!(w.player.gap < gap0 - 2.0, "gap {} → {}", gap0, w.player.gap);
    }

    #[test]
    fn a_car_ends_the_run_unless_practising() {
        let mut w = empty(1);
        w.car(0, 5.0);
        run(&mut w, 1.5);
        assert_eq!((w.state, w.lose_reason), (STATE_LOST, LOSE_CRASH));

        let mut w = empty(1);
        w.p[PRACTICE] = 1.0;
        w.car(0, 5.0);
        run(&mut w, 1.5);
        assert_eq!((w.state, w.stumbles), (STATE_PLAYING, 1));
    }

    #[test]
    fn a_dodge_avoids_a_car() {
        let mut w = empty(1);
        w.car(0, 6.0);
        run(&mut w, 0.2);
        w.lane(1);
        run(&mut w, 1.5);
        assert_eq!((w.state, w.stumbles), (STATE_PLAYING, 0));
    }

    #[test]
    fn surges_peak_mid_window_and_rest_between() {
        assert_eq!(surge_at(10.0, 85.0), 0.0);
        assert!((surge_at(40.0 + 16.0, 85.0) - 1.0).abs() < 1e-4);
        assert_eq!(surge_at(40.0 + 50.0, 85.0), 0.0);
        assert!(surge_at(40.0 + 85.0 + 8.0, 85.0) > 0.5);
        assert_eq!(surge_at(200.0, 0.0), 0.0);
    }

    #[test]
    fn running_into_a_gap_falls_and_a_jump_crosses_it() {
        let mut w = empty(1);
        w.gap(6.0);
        run(&mut w, 2.0);
        assert_eq!((w.state, w.lose_reason), (STATE_LOST, LOSE_FALL));

        let mut w = empty(1);
        w.gap(6.0);
        run(&mut w, 3.0 / 8.0);
        w.jump();
        run(&mut w, 1.5);
        assert_eq!(w.state, STATE_PLAYING, "jumped the gap");
        assert!(w.player.grounded && w.player.z > 8.0);
    }

    #[test]
    fn coyote_time_allows_a_late_jump() {
        let mut w = empty(1);
        w.gap(6.0);
        // Run until just past the lip, then jump.
        while w.floor_at(w.player.z) {
            w.advance(DT);
        }
        w.advance(DT * 3.0);
        assert!(!w.player.grounded);
        w.jump();
        w.advance(DT);
        assert!(w.player.vy > 0.0, "coyote jump took off");
    }

    #[test]
    fn repeated_stumbles_get_you_caught() {
        let mut w = empty(1);
        for i in 0..6 {
            w.barrel(0, 4.0 + i as f32 * 6.0);
        }
        run(&mut w, 8.0);
        assert_eq!((w.state, w.lose_reason), (STATE_LOST, LOSE_CAUGHT), "gap {}", w.player.gap);
    }

    #[test]
    fn nuts_collect_once_and_the_finish_wins() {
        let mut w = empty(1);
        w.course = 20.0;
        w.nut_line(0, 3.0, 3, 2.0);
        run(&mut w, 4.0);
        assert_eq!((w.collected, w.state), (3, STATE_WON));
        assert_eq!(kinds(&w).iter().filter(|k| **k == EV_NUT).count(), 3);
        assert!(kinds(&w).contains(&EV_WIN));
    }

    #[test]
    fn the_default_course_has_a_way_through_every_pattern() {
        for seed in 1..40 {
            let w = World::new(seed);
            assert!(w.obstacles.len() > 10 && w.nuts.len() > 20, "seed {seed}");
            // At any z, cars never block all three lanes, and no car sits on a gap.
            for o in w.obstacles.iter().filter(|o| o.kind == OB_CAR) {
                let lanes: Vec<i8> = w.obstacles.iter().filter(|c| c.kind == OB_CAR && (c.z - o.z).abs() < 3.0).map(|c| c.lane).collect();
                assert!(lanes.len() < 3, "seed {seed}: cars {lanes:?}");
                assert!(w.floor_at(o.z), "seed {seed}: car over a gap");
            }
            assert!(w.obstacles.iter().all(|o| o.z > 30.0 && o.z < w.course - 20.0));
        }
    }

    #[test]
    fn viewer_mode_runs_no_rules() {
        let mut w = empty(1);
        w.set_mode(MODE_VIEWER);
        run(&mut w, 2.0);
        assert_eq!((w.player.z, w.state), (0.0, STATE_PLAYING));
    }

    #[test]
    fn deterministic_for_a_seed() {
        let script = |seed| {
            let mut w = World::new(seed);
            w.round_start();
            let mut trace = Vec::new();
            for f in 0..600 {
                if f % 40 == 0 {
                    w.lane(if f % 80 == 0 { 1 } else { -1 });
                }
                if f % 60 == 20 {
                    w.strafe(if f % 120 == 20 { -0.7 } else { 0.0 });
                }
                if f % 50 == 0 {
                    w.jump();
                }
                w.advance(if f % 3 == 0 { 0.021 } else { 1.0 / 60.0 });
                trace.extend(w.out_stats.iter().map(|v| v.to_bits()));
                trace.extend(w.out_player.iter().map(|v| v.to_bits()));
                w.events.clear();
            }
            trace
        };
        assert_eq!(script(42), script(42));
        assert_ne!(script(42), script(43));
    }

    #[test]
    fn drawn_pose_trails_by_at_most_one_step() {
        let mut w = empty(1);
        w.p[PRACTICE] = 1.0;
        for _ in 0..200 {
            w.advance(0.0071);
            let d = w.out_player[PL_Z] - w.out_player[PL_RZ];
            assert!((0.0..=w.p[RUN_SPEED] * DT + 1e-4).contains(&d), "{d}");
        }
    }
}
