use stellar_sdk::soroban_env_common::xdr::ScVal;

#[no_mangle]
pub extern "C" fn helper1(x: i32) -> i32 {
    x * 2
}

#[no_mangle]
pub extern "C" fn helper2(x: i32) -> i32 {
    x + 5
}

#[no_mangle]
pub extern "C" fn main_operation(x: i32) -> i32 {
    let h1 = helper1(x);
    let h2 = helper2(h1);
    h2 - x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_helper1() {
        assert_eq!(helper1(5), 10);
    }

    #[test]
    fn test_helper2() {
        assert_eq!(helper2(5), 10);
    }

    #[test]
    fn test_main_operation() {
        assert_eq!(main_operation(5), 5);
    }
}
