use stellar_sdk::soroban_env_common::xdr::ScVal;

#[no_mangle]
pub extern "C" fn sum_up_to(n: i32) -> i32 {
    let mut sum = 0;
    let mut i = 0;
    while i < n {
        sum += i;
        i += 1;
    }
    sum
}

#[no_mangle]
pub extern "C" fn factorial(n: i32) -> i32 {
    if n <= 1 {
        1
    } else {
        n * factorial(n - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sum_up_to() {
        assert_eq!(sum_up_to(5), 10);
        assert_eq!(sum_up_to(10), 45);
    }

    #[test]
    fn test_factorial() {
        assert_eq!(factorial(5), 120);
        assert_eq!(factorial(0), 1);
    }
}
