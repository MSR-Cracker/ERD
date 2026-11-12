<?php

return [
    'suppliers' => [
        'supplier_id' => 'BIGINT primary key',
        'name' => 'VARCHAR(180) not null',
        'origin' => 'VARCHAR(32) nullable',
    ],
    'stock_payment_orders' => [
        'order_id' => 'BIGINT primary key',
        'supplier_id' => 'BIGINT references suppliers.supplier_id',
        'total_price' => 'DECIMAL derived from line items',
    ],
];
