//! PCG32 (XSH-RR). Integer-only, so native and WASM give identical streams.

#[derive(Clone, Debug)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

const MULT: u64 = 6364136223846793005;

impl Pcg32 {
    pub fn new(seed: u64, stream: u64) -> Pcg32 {
        let mut r = Pcg32 { state: 0, inc: (stream << 1) | 1 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MULT).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// The generator's (state, increment), for state hashes.
    pub fn raw_state(&self) -> (u64, u64) {
        (self.state, self.inc)
    }

    /// Uniform in [0, n). Lemire-free simple modulo with rejection.
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        debug_assert!(n > 0);
        let threshold = n.wrapping_neg() % n;
        loop {
            let r = self.next_u32();
            if r >= threshold {
                return r % n;
            }
        }
    }

    /// Uniform in [0, 1) with 24 bits of precision (exact in f32).
    #[inline]
    pub fn f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_stream() {
        // Reference values from the PCG32 demo (seed 42, stream 54).
        let mut r = Pcg32::new(42, 54);
        let expect = [0xa15c02b7u32, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e];
        for e in expect {
            assert_eq!(r.next_u32(), e);
        }
    }
}
