/** #574: example in-memory reference registry; persist in a real application. */
export type MemoType = 'none' | 'text' | 'id' | 'hash' | 'return';
export interface PaymentReference {
  id: string;
  customerOrOrderId: string;
  memoType: Exclude<MemoType, 'none'>;
  memo: string; // Text, decimal ID, or lowercase 64-character hash hex.
  destination: string;
  asset: string; // 'XLM' or 'CODE:ISSUER'.
  amount: string; // Decimal string, 7 or fewer places.
  status: 'unpaid' | 'paid';
}
export const sampleRegistry: PaymentReference[] = [];
