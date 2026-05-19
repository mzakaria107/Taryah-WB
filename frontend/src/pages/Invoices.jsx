import React from 'react';
import InvoiceTable from '../components/Dashboard/InvoiceTable';

export default function Invoices() {
  return (
    <>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>
        جميع الفواتير
      </h1>
      <InvoiceTable filters={{}} />
    </>
  );
}
