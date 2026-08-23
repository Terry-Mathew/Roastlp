import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuditProgress } from "../../../components/audit-progress";
import { PRODUCT_NAME } from "../../../lib/product";

export const metadata: Metadata = {
  title: `Auditing your page — ${PRODUCT_NAME}`,
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AuditingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) redirect("/");

  return (
    <main className="bg-ink text-paper min-h-screen">
      <header className="border-rule border-b">
        <div className="page-shell flex min-h-14 items-center justify-between gap-4 py-3 font-mono text-[0.68rem] tracking-[0.16em] uppercase sm:text-xs">
          <Link href="/" className="focus-ring text-paper font-bold">
            {PRODUCT_NAME}
          </Link>
          <p className="text-muted">Audit in progress</p>
        </div>
      </header>
      <AuditProgress roastId={id} />
    </main>
  );
}
