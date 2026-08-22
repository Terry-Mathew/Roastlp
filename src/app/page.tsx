import { PRODUCT_NAME, ROAST_PRICE_INR } from "@/lib/product";

export default function Home() {
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-950 px-6 text-zinc-50">
      <section className="max-w-2xl text-center">
        <p className="mb-3 text-sm font-semibold tracking-[0.2em] text-orange-400 uppercase">
          Phase 1 engineering foundation
        </p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
          {PRODUCT_NAME} foundation
        </h1>
        <p className="mt-6 text-lg leading-8 text-zinc-300">
          The production purchase-to-report flow will be built ticket by ticket.
          The server-owned launch price is ₹{ROAST_PRICE_INR}.
        </p>
      </section>
    </main>
  );
}
