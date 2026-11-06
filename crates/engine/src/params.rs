//! Live-tunable parameters. A game declares its table once with `params!`;
//! the ids are part of the JS ABI: the game's `src/sim-abi.ts` lists the same
//! ids with labels and slider ranges, and the DEV tuning panel is built from
//! that list. Append new ids; don't renumber (saved tunings refer to ids).

/// Declare a params table in the current module:
///
/// ```
/// pub mod params {
///     vgd_engine::params! {
///         0 MOVE_SPEED = 4.5;   // m/s
///         1 TIME_LIMIT = 40.0;  // s
///     }
/// }
/// assert_eq!(params::COUNT, 2);
/// assert_eq!(params::DEFAULTS[params::TIME_LIMIT], 40.0);
/// ```
///
/// Generates one `usize` const per id, `COUNT`, `DEFAULTS: [f32; COUNT]` and
/// `IDS`. Ids must be dense and in order (0, 1, 2, …): anything else fails to
/// compile. An empty table (`params! {}`) is fine.
#[macro_export]
macro_rules! params {
    ($( $id:literal $name:ident = $default:expr ; )*) => {
        $( pub const $name: usize = $id; )*
        pub const COUNT: usize = <[usize]>::len(&[$($id),*]);
        pub const DEFAULTS: [f32; COUNT] = [$($default),*];
        /// Every id in declaration order.
        pub const IDS: [usize; COUNT] = [$($id),*];
        const _: () = {
            let mut i = 0;
            while i < COUNT {
                assert!(IDS[i] == i, "params! ids must be 0..COUNT in declaration order");
                i += 1;
            }
        };
    };
}

#[cfg(test)]
mod tests {
    mod table {
        crate::params! {
            0 SPEED = 4.5;
            1 LIMIT = 40.0;
            2 RADIUS = 0.3;
        }
    }
    mod empty {
        crate::params! {}
    }

    #[test]
    fn a_table_is_dense_with_defaults_by_id() {
        assert_eq!(table::COUNT, 3);
        assert_eq!(table::IDS, [table::SPEED, 1, 2]);
        assert_eq!(table::DEFAULTS[table::LIMIT], 40.0);
        assert_eq!(table::DEFAULTS[table::RADIUS], 0.3);
    }

    #[test]
    fn an_empty_table_compiles() {
        assert_eq!(empty::COUNT, 0);
        assert!(empty::DEFAULTS.is_empty());
    }
}
