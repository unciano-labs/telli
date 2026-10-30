// Money formatting shared by server and client. Amounts are in cents (or centavos).

/** "$39", "$39.50", "−$12". */
export function formatUsd(cents: number) {
  const value = Math.abs(cents) / 100;
  const text = value.toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return `${cents < 0 ? '−' : ''}$${text}`;
}

/** "₱2,496". Rounded to the peso. */
export function formatPhp(centavos: number) {
  return `₱${Math.round(centavos / 100).toLocaleString('en-PH')}`;
}

/** A price in a business's own currency (bookings): "₱1,200", "$45". */
export function formatPrice(cents: number, currency: string) {
  if (currency === 'PHP') return formatPhp(cents);
  if (currency === 'USD') return formatUsd(cents);
  if (currency === 'EUR') return `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  return `${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
}
