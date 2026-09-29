use stellar_sdk::soroban_env_common::xdr::{
    ScVal, ScSymbol, ScInt, ScError, Error as XdrError
};

#[no_mangle]
pub extern "C" fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[no_mangle]
pub extern "C" fn multiply(a: i32, b: i32) -> i32 {
    a * b
}

#[no_mangle]
pub extern "C" fn compute(x: i32, y: i32) -> i32 {
    let sum = add(x, y);
    multiply(sum, x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    fn test_multiply() {
        assert_eq!(multiply(2, 3), 6);
    }

    #[test]
    fn test_compute() {
        assert_eq!(compute(2, 3), 10);
    }
}
