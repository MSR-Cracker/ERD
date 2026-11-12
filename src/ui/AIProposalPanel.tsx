import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, LoaderCircle, Lock, MessageSquarePlus, Sparkles, Wand2, X } from 'lucide-react';
import type { Attribute, Entity, Relationship, SchemaModel, SchemaPatchOperation } from '../model/types';
import type { CanvasLocale } from './EntityNode';
import { useSchemaStore } from '../store/store';
import {
  DEFAULT_CLIENT_GEMINI_MODEL,
  getStoredAIConfig,
  requestEditProposal,
  requestParseProposal,
  type AIProgress,
} from '../ai/client';
import type { ParseResult } from '../parsers';

interface AIProposalPanelProps {
  source?: string;
  locale: CanvasLocale;
  onClose: () => void;
  onOpenSettings?: () => void;
  onRequestApplyModel?: (model: SchemaModel, mode: 'replace' | 'merge' | 'ask') => void;
  onBusyChange?: (busy: boolean) => void;
  onRecordPrompt?: (prompt: string, mode: "interpret" | "edit") => void;
}

const COPY = {
  en: {
    aria: 'AI schema assistant dialog',
    kicker: 'AI ERD ARCHITECT',
    title: 'Ask AI — Build or Upgrade ERD',
    subtitle: 'Write any database description, paste SQL/JSON/Markdown, or ask to upgrade and expand your current diagram.',
    close: 'Close AI dialog',
    createMode: 'New Diagram (Replace Current)',
    editMode: 'Upgrade / Add to Current Diagram',
    promptLabel: 'Write your description, code, or upgrade request:',
    promptPlaceholder: 'Write any system (e.g. pharmacy, hospital, store, school, hotel) or ask to expand the current database with more tables and details…',
    editLabel: 'What would you like to develop, expand, or add to the current diagram?',
    editPlaceholder: 'Example: Expand the database and add more details, or add shipping, payments, reviews, branches, inventory…',
    generateButton: 'Generate ERD Now',
    editButton: 'Upgrade & Apply Changes Now',
    tooLong: 'Input exceeds the 100,000-character limit.',
    sourceEmpty: 'Please write your request in the dialog box first.',
    appliedSuccess: 'ERD generated and applied to the canvas!',
    stage1: '1. Connecting & analyzing tables and columns…',
    stage2: '2. Building primary keys, foreign keys & relationships…',
    stage3: '3. Arranging Workbench ERD tables on canvas…',
    lockedNotice: 'Operation in progress — cannot be cancelled until completed',
  },
  ar: {
    aria: 'مربع حوار المساعد الذكي لبناء وتطوير مخططات قواعد البيانات',
    kicker: 'المساعد الذكي · ERD ARCHITECT',
    title: 'المساعد الذكي لبناء وتطوير مخطط ERD',
    subtitle: 'اكتب وصف أي نظام تريده، أو اطلب تطوير وتوسيع القاعدة الحالية، أو الصق نص # world أو SQL / JSON.',
    close: 'إغلاق نافذة الذكاء الاصطناعي',
    createMode: 'إنشاء مخطط جديد',
    editMode: 'تطوير أو إضافة على المخطط الحالي',
    promptLabel: 'اكتب وصف النظام أو طلب التطوير أو الصق الكود هنا:',
    promptPlaceholder: 'اكتب هنا أي نظام تريده (مثلاً: نظام صيدلية، مستشفى، متجر، مطعم، جامعة، فندق) أو اكتب "طور القاعدة اكتر وضيف تفاصيل اكتر"…',
    editLabel: 'اكتب التطوير أو الجداول والتفاصيل المراد إضافتها للمخطط الحالي:',
    editPlaceholder: 'مثال: طور القاعدة اكتر وضيف تفاصيل اكتر، أو أضف الفروع والمخازن والشحن والمدفوعات والتقييمات…',
    generateButton: 'توليد وبناء مخطط ERD الآن',
    editButton: 'تطوير وتطبيق التعديلات الآن',
    tooLong: 'النص يتجاوز الحد المسموح وهو 100,000 حرف.',
    sourceEmpty: 'يرجى كتابة طلبك في مربع الحوار أولاً.',
    appliedSuccess: 'تم بناء وتطوير الجداول والروابط وتطبيقها على المخطط بنجاح!',
    stage1: '١. جاري الاتصال وتحليل الجداول والأعمدة…',
    stage2: '٢. بناء المفاتيح الأساسية والأجنبية وربط العلاقات (PK / FK)…',
    stage3: '٣. رسم وتوزيع جداول ERD على اللوحة…',
    lockedNotice: 'العملية قيد التنفيذ الآن — لا يمكن الإلغاء لحين اكتمال العملية',
  },
} as const;

type RequestMode = 'interpret' | 'edit';

function sanitizeStatusMessage(rawMessage: string | undefined, locale: CanvasLocale): string {
  if (!rawMessage) return '';
  if (/connecting/i.test(rawMessage)) {
    return locale === 'ar' ? 'جاري الاتصال…' : 'Connecting…';
  }
  if (/retrying/i.test(rawMessage)) {
    return locale === 'ar' ? 'جاري معالجة وتوسيع المخطط…' : 'Processing schema expansion…';
  }
  if (/preparing|generating/i.test(rawMessage)) {
    return locale === 'ar' ? 'جاري تجهيز الجداول والعلاقات…' : 'Preparing structured diagram…';
  }
  if (/validating|checking/i.test(rawMessage)) {
    return locale === 'ar' ? 'جاري التحقق من الجداول والروابط…' : 'Validating tables and relations…';
  }
  return rawMessage.replace(/gemini[\s-]*[0-9.]*[a-z-]*/gi, locale === 'ar' ? 'النظام' : 'AI').trim();
}

/**
 * Detects whether the user's prompt is asking to upgrade, expand, modify, or add to the existing schema.
 */
function isExpansionOrEditCommand(text: string): boolean {
  const clean = text.trim();
  if (/create\s+table|#{2,6}\s+\S/i.test(clean)) return false;
  return /(?:طور|تطوير|وسع|توسيع|كبر|تكبير|تفاصيل\s*اكتر|تفاصيل\s*أكثر|جداول\s*اكتر|جداول\s*أكثر|زود|تزويد|حسن|تحسين|تحديث|حدث|عد[لّ]|تعديل|إضافة|اضافة|أضف|ضيف|حط|كمل|استكمل|اربط|احذف|امسح|شيل|إزالة|دمج|expand|enhance|improve|upgrade|enrich|develop|more\s+details|more\s+tables|more\s+columns|add\s+more|add\s+table|add\s+column|modify|update\s+schema)/i.test(clean);
}

interface ExpansionBlueprint {
  name: string;
  kind?: 'strong' | 'weak' | 'associative';
  keywords: RegExp;
  domain?: 'general' | 'medical' | 'education';
  linksTo: string[]; // candidate parent table name substrings
  attrs: Array<[string, string, boolean?]>;
}

const ENTERPRISE_EXPANSION_CATALOG: ExpansionBlueprint[] = [
  // Wave 1: Branches, Suppliers, Inventory, Payments, Shipments, Reviews
  {
    name: 'branches',
    keywords: /فرع|فروع|الفرع|الفروع|branch|branches|location/i,
    linksTo: [],
    attrs: [
      ['id', 'BIGINT', true],
      ['branch_code', 'VARCHAR(30)'],
      ['name', 'VARCHAR(150)'],
      ['city', 'VARCHAR(100)'],
      ['address', 'VARCHAR(255)'],
      ['phone', 'VARCHAR(40)'],
      ['manager_name', 'VARCHAR(120)'],
      ['is_active', 'BOOLEAN'],
    ],
  },
  {
    name: 'suppliers',
    keywords: /مورد|موردين|الموردين|شركات\s*توريد|supplier|vendor/i,
    linksTo: [],
    attrs: [
      ['id', 'BIGINT', true],
      ['company_name', 'VARCHAR(160)'],
      ['contact_person', 'VARCHAR(120)'],
      ['phone', 'VARCHAR(40)'],
      ['email', 'VARCHAR(255)'],
      ['tax_number', 'VARCHAR(60)'],
      ['country_city', 'VARCHAR(100)'],
      ['rating', 'DECIMAL(3,2)'],
    ],
  },
  {
    name: 'branch_inventory',
    kind: 'associative',
    keywords: /مخزون|جرد|كميات|مستودع|مخزن|مخازن|inventory|stock|warehouse/i,
    linksTo: ['branch', 'item', 'product', 'drug', 'book'],
    attrs: [
      ['id', 'BIGINT', true],
      ['shelf_location', 'VARCHAR(60)'],
      ['quantity_on_hand', 'INTEGER'],
      ['reserved_quantity', 'INTEGER'],
      ['reorder_threshold', 'INTEGER'],
      ['last_restocked_at', 'TIMESTAMP'],
    ],
  },
  {
    name: 'payments',
    keywords: /دفع|مدفوعات|المدفوعات|سداد|فواتير|معاملات\s*مالية|payment|billing|transaction/i,
    linksTo: ['order', 'customer', 'invoice', 'reservation', 'appointment', 'student'],
    attrs: [
      ['id', 'BIGINT', true],
      ['transaction_ref', 'VARCHAR(80)'],
      ['payment_method', 'VARCHAR(50)'],
      ['amount', 'DECIMAL(12,2)'],
      ['currency', 'VARCHAR(10)'],
      ['payment_status', 'VARCHAR(40)'],
      ['paid_at', 'TIMESTAMP'],
    ],
  },
  {
    name: 'shipments',
    keywords: /شحن|توصيل|شحنات|دليفري|مندوب|بوليصة|shipment|delivery|shipping|courier/i,
    linksTo: ['order', 'customer', 'staff', 'branch'],
    attrs: [
      ['id', 'BIGINT', true],
      ['tracking_number', 'VARCHAR(80)'],
      ['shipping_carrier', 'VARCHAR(100)'],
      ['delivery_address', 'VARCHAR(255)'],
      ['shipping_fee', 'DECIMAL(10,2)'],
      ['delivery_status', 'VARCHAR(40)'],
      ['shipped_at', 'TIMESTAMP'],
      ['delivered_at', 'TIMESTAMP'],
    ],
  },
  {
    name: 'reviews',
    keywords: /تقييم|تقييمات|تعليقات|آراء|مراجعات|review|rating|feedback/i,
    linksTo: ['customer', 'item', 'product', 'doctor', 'course', 'room'],
    attrs: [
      ['id', 'BIGINT', true],
      ['rating', 'INTEGER'],
      ['title', 'VARCHAR(150)'],
      ['comment', 'TEXT'],
      ['is_verified_purchase', 'BOOLEAN'],
      ['created_at', 'TIMESTAMP'],
    ],
  },
  // Wave 2: Coupons, Purchase Orders, Returns, Addresses, Notifications, Audit Logs
  {
    name: 'promotions_coupons',
    keywords: /كوبون|كوبونات|خصم|خصومات|عروض|ترويج|coupon|promo|discount/i,
    linksTo: ['order', 'category'],
    attrs: [
      ['id', 'BIGINT', true],
      ['coupon_code', 'VARCHAR(50)'],
      ['discount_type', 'VARCHAR(30)'],
      ['discount_value', 'DECIMAL(10,2)'],
      ['min_order_amount', 'DECIMAL(10,2)'],
      ['max_uses', 'INTEGER'],
      ['expires_at', 'TIMESTAMP'],
      ['is_active', 'BOOLEAN'],
    ],
  },
  {
    name: 'purchase_orders',
    keywords: /أوامر\s*شراء|توريد|مشتريات|purchase_order|procurement/i,
    linksTo: ['supplier', 'branch', 'staff'],
    attrs: [
      ['id', 'BIGINT', true],
      ['po_number', 'VARCHAR(60)'],
      ['total_cost', 'DECIMAL(12,2)'],
      ['payment_terms', 'VARCHAR(80)'],
      ['status', 'VARCHAR(40)'],
      ['ordered_at', 'TIMESTAMP'],
      ['expected_at', 'DATE'],
    ],
  },
  {
    name: 'purchase_order_items',
    kind: 'associative',
    keywords: /تفاصيل\s*الشراء|بنود\s*التوريد|purchase_order_item/i,
    linksTo: ['purchase_order', 'item', 'product'],
    attrs: [
      ['id', 'BIGINT', true],
      ['batch_number', 'VARCHAR(60)'],
      ['ordered_qty', 'INTEGER'],
      ['received_qty', 'INTEGER'],
      ['unit_cost', 'DECIMAL(10,2)'],
      ['expiry_date', 'DATE'],
    ],
  },
  {
    name: 'order_returns',
    keywords: /مرتجع|مرتجعات|استرجاع|استبدال|return|refund/i,
    linksTo: ['order', 'customer', 'item'],
    attrs: [
      ['id', 'BIGINT', true],
      ['return_reason', 'VARCHAR(200)'],
      ['quantity', 'INTEGER'],
      ['refund_amount', 'DECIMAL(10,2)'],
      ['return_status', 'VARCHAR(40)'],
      ['requested_at', 'TIMESTAMP'],
    ],
  },
  {
    name: 'customer_addresses',
    kind: 'weak',
    keywords: /عناوين|عنوان\s*العميل|خريطة|address|addresses/i,
    linksTo: ['customer', 'client'],
    attrs: [
      ['id', 'BIGINT', true],
      ['address_label', 'VARCHAR(60)'],
      ['governorate', 'VARCHAR(100)'],
      ['city', 'VARCHAR(100)'],
      ['street_details', 'VARCHAR(255)'],
      ['postal_code', 'VARCHAR(20)'],
      ['is_default', 'BOOLEAN'],
    ],
  },
  {
    name: 'audit_logs',
    keywords: /سجل|سجلات|مراقبة|حركات|أمان|audit|log|activity_log/i,
    linksTo: ['staff', 'employee', 'doctor'],
    attrs: [
      ['id', 'BIGINT', true],
      ['action_type', 'VARCHAR(80)'],
      ['target_table', 'VARCHAR(80)'],
      ['record_id', 'BIGINT'],
      ['ip_address', 'VARCHAR(45)'],
      ['created_at', 'TIMESTAMP'],
    ],
  },
  // Wave 3: Shifts, Payroll, Wallets, Notifications, Support Tickets, Expenses
  {
    name: 'staff_shifts',
    keywords: /ورديات|حضور|انصراف|مواعيد\s*العمل|shift|attendance/i,
    linksTo: ['staff', 'employee', 'branch'],
    attrs: [
      ['id', 'BIGINT', true],
      ['shift_date', 'DATE'],
      ['check_in_time', 'TIME'],
      ['check_out_time', 'TIME'],
      ['overtime_hours', 'DECIMAL(4,2)'],
      ['status', 'VARCHAR(40)'],
    ],
  },
  {
    name: 'payroll_records',
    keywords: /رواتب|مرتبات|كشف\s*حساب|مكافآت|خصم\s*موظف|payroll|salary_slip/i,
    linksTo: ['staff', 'employee'],
    attrs: [
      ['id', 'BIGINT', true],
      ['payroll_month', 'VARCHAR(20)'],
      ['base_salary', 'DECIMAL(10,2)'],
      ['bonuses', 'DECIMAL(10,2)'],
      ['deductions', 'DECIMAL(10,2)'],
      ['net_salary', 'DECIMAL(10,2)'],
      ['paid_at', 'DATE'],
    ],
  },
  {
    name: 'customer_wallets',
    keywords: /محفظة|رصيد|نقاط\s*ولاء|wallet|loyalty/i,
    linksTo: ['customer', 'client'],
    attrs: [
      ['id', 'BIGINT', true],
      ['balance', 'DECIMAL(12,2)'],
      ['loyalty_points', 'INTEGER'],
      ['tier_level', 'VARCHAR(40)'],
      ['updated_at', 'TIMESTAMP'],
    ],
  },
  {
    name: 'notifications',
    keywords: /إشعار|اشعارات|تنبيهات|رسائل|notification|alert/i,
    linksTo: ['customer', 'staff', 'patient', 'student'],
    attrs: [
      ['id', 'BIGINT', true],
      ['title', 'VARCHAR(160)'],
      ['message_body', 'TEXT'],
      ['channel', 'VARCHAR(40)'],
      ['is_read', 'BOOLEAN'],
      ['sent_at', 'TIMESTAMP'],
    ],
  },
  {
    name: 'support_tickets',
    keywords: /شكاوى|دعم\s*فني|تذاكر|خدمة\s*عملاء|ticket|support|complaint/i,
    linksTo: ['customer', 'order', 'staff'],
    attrs: [
      ['id', 'BIGINT', true],
      ['subject', 'VARCHAR(180)'],
      ['priority', 'VARCHAR(30)'],
      ['ticket_status', 'VARCHAR(40)'],
      ['resolution_notes', 'TEXT'],
      ['created_at', 'TIMESTAMP'],
    ],
  },
  {
    name: 'branch_expenses',
    keywords: /مصروفات|مصاريف|تكاليف|ميزانية|expense|cost/i,
    linksTo: ['branch', 'department', 'staff'],
    attrs: [
      ['id', 'BIGINT', true],
      ['expense_type', 'VARCHAR(80)'],
      ['amount', 'DECIMAL(12,2)'],
      ['description', 'VARCHAR(255)'],
      ['expense_date', 'DATE'],
    ],
  },
  // Domain-Specific Medical Expansion Modules
  {
    name: 'lab_tests',
    domain: 'medical',
    keywords: /تحاليل|مختبر|معمل|فحوصات|lab|test/i,
    linksTo: ['patient', 'doctor', 'appointment'],
    attrs: [
      ['id', 'BIGINT', true],
      ['test_name', 'VARCHAR(160)'],
      ['sample_type', 'VARCHAR(60)'],
      ['result_summary', 'TEXT'],
      ['reference_range', 'VARCHAR(100)'],
      ['tested_at', 'TIMESTAMP'],
    ],
  },
  {
    name: 'insurance_claims',
    domain: 'medical',
    keywords: /تأمين|بوليصة\s*تأمين|مطالبات|insurance|claim/i,
    linksTo: ['patient', 'invoice'],
    attrs: [
      ['id', 'BIGINT', true],
      ['insurance_provider', 'VARCHAR(150)'],
      ['policy_number', 'VARCHAR(80)'],
      ['coverage_percent', 'DECIMAL(5,2)'],
      ['approved_amount', 'DECIMAL(10,2)'],
      ['claim_status', 'VARCHAR(40)'],
    ],
  },
  // Domain-Specific Education Expansion Modules
  {
    name: 'attendance_records',
    domain: 'education',
    keywords: /غياب|حضور\s*الطلاب|سجل\s*الحضور|attendance/i,
    linksTo: ['student', 'course'],
    attrs: [
      ['id', 'BIGINT', true],
      ['session_date', 'DATE'],
      ['attendance_status', 'VARCHAR(30)'],
      ['remarks', 'VARCHAR(180)'],
    ],
  },
  {
    name: 'tuition_payments',
    domain: 'education',
    keywords: /مصروفات\s*دراسية|أقساط|رسوم|tuition|fee/i,
    linksTo: ['student'],
    attrs: [
      ['id', 'BIGINT', true],
      ['academic_year', 'VARCHAR(20)'],
      ['amount_paid', 'DECIMAL(10,2)'],
      ['payment_method', 'VARCHAR(50)'],
      ['paid_at', 'DATE'],
    ],
  },
];

/**
 * Enriches existing tables with realistic missing columns AND adds 5-6 new interconnected
 * tables & relationships tailored to the current schema and user instruction.
 */
function buildDeepSchemaExpansion(instruction: string, currentSchema: SchemaModel): SchemaPatchOperation[] {
  const ops: SchemaPatchOperation[] = [];
  const text = instruction.trim();

  // 1. Check if the user explicitly asked to delete a specific table
  const dropMatch = text.match(/^(?:delete|drop|remove|احذف|امسح|شيل|إزالة)\s+(?:table|entity|جدول|كيان)?\s*([A-Za-z\u0600-\u06FF][\w\u0600-\u06FF_-]*)$/i);
  if (dropMatch) {
    const targetName = dropMatch[1]!.replace(/^ال/, '').toLowerCase();
    const found = currentSchema.entities.find(
      (e) => e.name.toLowerCase() === targetName || e.name.toLowerCase().includes(targetName),
    );
    if (found) {
      ops.push({ op: 'entity.delete', entityId: found.id });
      return ops;
    }
  }

  // 2. Check if the user explicitly asked to add a single column to a specific table
  const addColMatch = text.match(/^(?:add|أضف|ضيف|حط|زود)\s+(?:column|field|attribute|عمود|حقل|خاصية)\s+([A-Za-z\u0600-\u06FF][\w\u0600-\u06FF_-]*)\s+(?:to|in|on|إلى|في|لجدول|لـ|على)\s+(?:table|جدول)?\s*([A-Za-z\u0600-\u06FF][\w\u0600-\u06FF_-]*)$/i);
  if (addColMatch) {
    const colName = addColMatch[1]!.trim();
    const tblQuery = addColMatch[2]!.replace(/^ال/, '').toLowerCase();
    const targetEntity = currentSchema.entities.find(
      (e) => e.name.toLowerCase() === tblQuery || e.name.toLowerCase().includes(tblQuery),
    ) ?? currentSchema.entities[0];
    if (targetEntity && !targetEntity.attributes.some((a) => a.name.toLowerCase() === colName.toLowerCase())) {
      const attr: Attribute = {
        id: `${targetEntity.id}.${colName.toLowerCase()}-${crypto.randomUUID().slice(0, 4)}`,
        name: colName,
        dataType: /price|salary|amount|cost|سعر|راتب|مبلغ/i.test(colName) ? 'DECIMAL(10,2)' : /date|تاريخ/i.test(colName) ? 'DATE' : 'VARCHAR(150)',
        isPK: false,
        isFK: false,
        isUnique: false,
        isNullable: true,
        kind: 'simple',
        notes: '',
      };
      ops.push({ op: 'attribute.add', entityId: targetEntity.id, attribute: attr });
      return ops;
    }
  }

  // 3. Enrich existing tables with realistic detailed columns when user asks for more details / development
  const columnEnrichments: Array<{ matchTable: RegExp; columns: Array<[string, string]> }> = [
    {
      matchTable: /customer|client|guest|tenant|member|patient|student/i,
      columns: [
        ['national_id', 'VARCHAR(30)'],
        ['address', 'VARCHAR(255)'],
        ['city', 'VARCHAR(100)'],
        ['birth_date', 'DATE'],
        ['is_active', 'BOOLEAN'],
      ],
    },
    {
      matchTable: /^items?$|^products?$|^menu_items?$|^books?$|^drugs?$/i,
      columns: [
        ['sku_barcode', 'VARCHAR(80)'],
        ['cost_price', 'DECIMAL(10,2)'],
        ['stock_quantity', 'INTEGER'],
        ['min_stock_alert', 'INTEGER'],
        ['tax_percent', 'DECIMAL(5,2)'],
        ['is_active', 'BOOLEAN'],
      ],
    },
    {
      matchTable: /^orders?$|^reservations?$|^appointments?$|^invoices?$/i,
      columns: [
        ['reference_number', 'VARCHAR(60)'],
        ['discount_amount', 'DECIMAL(10,2)'],
        ['tax_amount', 'DECIMAL(10,2)'],
        ['payment_method', 'VARCHAR(50)'],
        ['notes', 'TEXT'],
      ],
    },
    {
      matchTable: /^staff$|^employees?$|^doctors?$|^instructors?$|^trainers?$/i,
      columns: [
        ['national_id', 'VARCHAR(30)'],
        ['email', 'VARCHAR(255)'],
        ['salary', 'DECIMAL(10,2)'],
        ['hire_date', 'DATE'],
        ['shift_type', 'VARCHAR(40)'],
      ],
    },
    {
      matchTable: /^categories$|^departments$|^menu_categories$/i,
      columns: [
        ['code', 'VARCHAR(40)'],
        ['display_order', 'INTEGER'],
        ['is_active', 'BOOLEAN'],
      ],
    },
  ];

  for (const entity of currentSchema.entities) {
    const existingColNames = new Set(entity.attributes.map((a) => a.name.toLowerCase()));
    for (const rule of columnEnrichments) {
      if (rule.matchTable.test(entity.name)) {
        let addedForEntity = 0;
        for (const [colName, colType] of rule.columns) {
          if (!existingColNames.has(colName.toLowerCase()) && addedForEntity < 3) {
            ops.push({
              op: 'attribute.add',
              entityId: entity.id,
              attribute: {
                id: `${entity.id}.${colName}`,
                name: colName,
                dataType: colType,
                isPK: false,
                isFK: false,
                isUnique: colName === 'sku_barcode' || colName === 'reference_number',
                isNullable: true,
                kind: 'simple',
                notes: '',
              },
            });
            existingColNames.add(colName.toLowerCase());
            addedForEntity += 1;
          }
        }
      }
    }
  }

  // 4. Determine domain of current schema (medical, education, or general/commerce)
  const existingTableNames = new Set(currentSchema.entities.map((e) => e.name.toLowerCase()));
  const isMedical = currentSchema.entities.some((e) => /patient|doctor|appointment|clinic|hospital/i.test(e.name));
  const isEducation = currentSchema.entities.some((e) => /student|course|instructor|enrollment|exam/i.test(e.name));

  // Filter blueprints that do not yet exist in currentSchema
  const availableBlueprints = ENTERPRISE_EXPANSION_CATALOG.filter((bp) => {
    if (existingTableNames.has(bp.name.toLowerCase())) return false;
    if (bp.domain === 'medical' && !isMedical) return false;
    if (bp.domain === 'education' && !isEducation) return false;
    return true;
  });

  // Prioritize blueprints explicitly mentioned in the user's instruction
  const keywordMatched = availableBlueprints.filter((bp) => bp.keywords.test(text));
  const remaining = availableBlueprints.filter((bp) => !keywordMatched.includes(bp));

  // Select up to 6 new tables to add in this expansion wave
  const selectedBlueprints = [...keywordMatched, ...remaining].slice(0, 6);

  // Track all entities (existing + newly added in this wave) so new associative tables can link to new parent tables too!
  const allEntitiesPool: Entity[] = [...currentSchema.entities];

  for (const bp of selectedBlueprints) {
    const newEntityId = `entity-${bp.name.toLowerCase()}-${crypto.randomUUID().slice(0, 5)}`;
    const attrs: Attribute[] = [];
    const pendingRels: Relationship[] = [];

    // Primary key first
    const pkDef = bp.attrs.find((a) => a[2]) ?? ['id', 'BIGINT', true];
    attrs.push({
      id: `${newEntityId}.${pkDef[0]}`,
      name: pkDef[0],
      dataType: pkDef[1],
      isPK: true,
      isFK: false,
      isUnique: true,
      isNullable: false,
      kind: 'simple',
      notes: '',
    });

    // Link foreign keys to matching parent entities in allEntitiesPool
    const linkedParentIds = new Set<string>();
    for (const targetSubstr of bp.linksTo) {
      const parent = allEntitiesPool.find(
        (ent) =>
          !linkedParentIds.has(ent.id) &&
          ent.name.toLowerCase().includes(targetSubstr.toLowerCase()),
      );
      const parentPk = parent?.attributes.find((a) => a.isPK);
      if (parent && parentPk) {
        linkedParentIds.add(parent.id);
        const singularParent = parent.name.toLowerCase().replace(/ies$/, 'y').replace(/ches$/, 'ch').replace(/s$/, '');
        const fkColName = `${singularParent}_id`;
        if (!attrs.some((a) => a.name === fkColName)) {
          attrs.push({
            id: `${newEntityId}.${fkColName}`,
            name: fkColName,
            dataType: parentPk.dataType || 'BIGINT',
            isPK: false,
            isFK: true,
            isUnique: false,
            isNullable: false,
            kind: 'simple',
            foreignKeyRef: { entityId: parent.id, attributeId: parentPk.id },
            notes: '',
          });
          pendingRels.push({
            id: `rel-${parent.id}-${newEntityId}-${fkColName}`,
            from: parent.id,
            to: newEntityId,
            fromCardinality: '1',
            toCardinality: '0..N',
            identifying: bp.kind === 'associative' || bp.kind === 'weak',
            participation: 'partial',
            label: `${parent.name} → ${bp.name}`,
            attributes: [],
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
            notes: '',
          });
        }
      }
    }

    // Fallback: if bp had linksTo but none matched, link to the primary entity in currentSchema so it's never floating unlinked
    if (pendingRels.length === 0 && bp.linksTo.length > 0 && currentSchema.entities.length > 0) {
      const fallbackParent = currentSchema.entities[0]!;
      const fallbackPk = fallbackParent.attributes.find((a) => a.isPK);
      if (fallbackPk) {
        const singularParent = fallbackParent.name.toLowerCase().replace(/s$/, '');
        const fkColName = `${singularParent}_id`;
        attrs.push({
          id: `${newEntityId}.${fkColName}`,
          name: fkColName,
          dataType: fallbackPk.dataType || 'BIGINT',
          isPK: false,
          isFK: true,
          isUnique: false,
          isNullable: false,
          kind: 'simple',
          foreignKeyRef: { entityId: fallbackParent.id, attributeId: fallbackPk.id },
          notes: '',
        });
        pendingRels.push({
          id: `rel-${fallbackParent.id}-${newEntityId}`,
          from: fallbackParent.id,
          to: newEntityId,
          fromCardinality: '1',
          toCardinality: '0..N',
          identifying: false,
          participation: 'partial',
          label: `${fallbackParent.name} → ${bp.name}`,
          attributes: [],
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
          notes: '',
        });
      }
    }

    // Add remaining attributes from blueprint
    for (const [colName, colType, isPK] of bp.attrs) {
      if (isPK) continue;
      if (attrs.some((a) => a.name.toLowerCase() === colName.toLowerCase())) continue;
      attrs.push({
        id: `${newEntityId}.${colName}`,
        name: colName,
        dataType: colType,
        isPK: false,
        isFK: false,
        isUnique: /code|tracking_number|transaction_ref|po_number|policy_number/i.test(colName),
        isNullable: true,
        kind: 'simple',
        notes: '',
      });
    }

    const newEntity: Entity = {
      id: newEntityId,
      name: bp.name,
      kind: bp.kind ?? 'strong',
      attributes: attrs,
      notes: '',
    };

    ops.push({ op: 'entity.add', entity: newEntity });
    allEntitiesPool.push(newEntity);

    // If branches or suppliers were added, also link existing orders/staff/items to them!
    if (bp.name === 'branches') {
      const staffOrOrder = currentSchema.entities.filter((e) => /^staff$|^orders?$/i.test(e.name));
      for (const targetEnt of staffOrOrder) {
        if (!targetEnt.attributes.some((a) => a.name === 'branch_id')) {
          ops.push({
            op: 'attribute.add',
            entityId: targetEnt.id,
            attribute: {
              id: `${targetEnt.id}.branch_id`,
              name: 'branch_id',
              dataType: 'BIGINT',
              isPK: false,
              isFK: true,
              isUnique: false,
              isNullable: true,
              kind: 'simple',
              foreignKeyRef: { entityId: newEntityId, attributeId: `${newEntityId}.id` },
              notes: '',
            },
          });
          ops.push({
            op: 'relationship.add',
            relationship: {
              id: `rel-${newEntityId}-${targetEnt.id}`,
              from: newEntityId,
              to: targetEnt.id,
              fromCardinality: '0..1',
              toCardinality: '0..N',
              identifying: false,
              participation: 'partial',
              label: `branches → ${targetEnt.name}`,
              attributes: [],
              onDelete: 'SET NULL',
              onUpdate: 'CASCADE',
              notes: '',
            },
          });
        }
      }
    }

    if (bp.name === 'suppliers') {
      const itemsEnt = currentSchema.entities.find((e) => /^items?$|^products?$/i.test(e.name));
      if (itemsEnt && !itemsEnt.attributes.some((a) => a.name === 'supplier_id')) {
        ops.push({
          op: 'attribute.add',
          entityId: itemsEnt.id,
          attribute: {
            id: `${itemsEnt.id}.supplier_id`,
            name: 'supplier_id',
            dataType: 'BIGINT',
            isPK: false,
            isFK: true,
            isUnique: false,
            isNullable: true,
            kind: 'simple',
            foreignKeyRef: { entityId: newEntityId, attributeId: `${newEntityId}.id` },
            notes: '',
          },
        });
        ops.push({
          op: 'relationship.add',
          relationship: {
            id: `rel-${newEntityId}-${itemsEnt.id}`,
            from: newEntityId,
            to: itemsEnt.id,
            fromCardinality: '0..1',
            toCardinality: '0..N',
            identifying: false,
            participation: 'partial',
            label: `suppliers → ${itemsEnt.name}`,
            attributes: [],
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
            notes: '',
          },
        });
      }
    }

    for (const rel of pendingRels) {
      ops.push({ op: 'relationship.add', relationship: rel });
    }
  }

  return ops;
}

export default function AIProposalPanel({ locale, onClose, onRequestApplyModel, onBusyChange, onRecordPrompt }: AIProposalPanelProps) {
  const copy = COPY[locale];
  const schema = useSchemaStore((state) => state.schema);
  const activeProjectId = useSchemaStore((state) => state.activeProjectId);
  const replaceSchema = useSchemaStore((state) => state.replaceSchema);
  const applyOperations = useSchemaStore((state) => state.applyOperations);

  const [mode, setMode] = useState<RequestMode>(() => (schema.entities.length > 0 ? 'edit' : 'interpret'));
  const [promptText, setPromptText] = useState('');
  const [loading, setLoading] = useState(false);
  const [progressStage, setProgressStage] = useState<1 | 2 | 3>(1);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progress, setProgress] = useState<AIProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Always notify parent of loading changes AND guarantee reset to false on unmount!
  useEffect(() => {
    onBusyChange?.(loading);
    return () => {
      onBusyChange?.(false);
    };
  }, [loading, onBusyChange]);

  // Block Escape key while AI operation is running
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (loading) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [loading, onClose]);

  useEffect(() => {
    if (!loading) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [loading]);

  useEffect(() => {
    if (!loading) {
      setProgressPercent(0);
      setProgressStage(1);
      return;
    }
    setProgressPercent(18);
    setProgressStage(1);
    const t1 = window.setTimeout(() => {
      setProgressPercent(54);
      setProgressStage(2);
    }, 300);
    const t2 = window.setTimeout(() => {
      setProgressPercent(88);
      setProgressStage(3);
    }, 640);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [loading]);

  const finishAndClose = () => {
    setLoading(false);
    setProgress(null);
    onBusyChange?.(false);
    onClose();
  };

  const applyModelNow = (newModel: SchemaModel, strategy: 'replace' | 'merge') => {
    setLoading(false);
    setProgress(null);
    onBusyChange?.(false);
    if (onRequestApplyModel) {
      onRequestApplyModel(newModel, strategy);
      return;
    }
    if (strategy === 'replace' || schema.entities.length === 0) {
      replaceSchema({
        ...newModel,
        id: activeProjectId,
        name: schema.name || newModel.name,
      });
    } else {
      const existingIds = new Set(schema.entities.map((e) => e.id));
      const ops: SchemaPatchOperation[] = [];
      for (const ent of newModel.entities) {
        if (!existingIds.has(ent.id)) ops.push({ op: 'entity.add', entity: ent });
      }
      for (const rel of newModel.relationships) {
        if (!schema.relationships.some((r) => r.id === rel.id)) {
          ops.push({ op: 'relationship.add', relationship: rel });
        }
      }
      if (ops.length > 0) applyOperations(ops);
    }
    onClose();
  };

  const executeAIRequest = async () => {
    if (loading) return;
    setError(null);
    setNotice(null);

    const trimmed = promptText.trim();
    if (!trimmed) {
      setError(copy.sourceEmpty);
      return;
    }
    if (trimmed.length > 100_000) {
      setError(copy.tooLong);
      return;
    }

    setLoading(true);
    const startedAt = Date.now();
    setProgress({ phase: 'connecting', message: locale === 'ar' ? 'جاري الاتصال…' : 'Connecting…' });

    const ensureSmoothProgressVisibility = async () => {
      const elapsed = Date.now() - startedAt;
      const minDuration = 900;
      if (elapsed < minDuration) {
        await new Promise((r) => window.setTimeout(r, minDuration - elapsed));
      }
      setProgressPercent(100);
      await new Promise((r) => window.setTimeout(r, 150));
    };

    const { apiKey, model } = getStoredAIConfig();
    const activeModel = model || DEFAULT_CLIENT_GEMINI_MODEL;

    // Smart intent detection: if schema already has tables AND user either selected 'edit' mode
    // OR wrote an expansion/upgrade instruction ("طور القاعدة اكتر وضيف تفاصيل اكتر"), run in upgrade/edit mode!
    const isExpandIntent = schema.entities.length > 0 && (mode === 'edit' || isExpansionOrEditCommand(trimmed));
    const effectiveMode: RequestMode = isExpandIntent ? 'edit' : mode;
    onRecordPrompt?.(trimmed, effectiveMode);
    const applyStrategy: 'replace' | 'merge' = effectiveMode === 'interpret' ? 'replace' : 'merge';

    const isExplicitStructuredCode = /#{2,6}\s+\S|create\s+table|\btable\s+[a-z0-9_]+\s*\{/i.test(trimmed);

    let localParse: ParseResult | undefined;
    if (!isExpandIntent || isExplicitStructuredCode) {
      try {
        const { parseSource } = await import('../parsers');
        localParse = parseSource(trimmed, { name: schema.name });
      } catch {
        // Continue
      }
    }

    // Fast-path for explicit structured outlines (# world), SQL DDL, JSON, DBML:
    if (localParse && localParse.model.entities.length >= 2 && (localParse.model.specializations.length > 0 || isExplicitStructuredCode)) {
      await ensureSmoothProgressVisibility();
      applyModelNow(localParse.model, applyStrategy);
      return;
    }

    const baseSchemaForAI: SchemaModel =
      applyStrategy === 'replace'
        ? { version: 1, id: activeProjectId, name: schema.name, entities: [], relationships: [], specializations: [], subjectAreas: [], notes: [] }
        : structuredClone(schema);

    try {
      const onProgress = (next: AIProgress) => setProgress(next);
      if (effectiveMode === 'interpret') {
        const patch = await requestParseProposal(
          {
            source: trimmed,
            currentSchema: baseSchemaForAI,
            ...(localParse ? { partialModel: localParse.model, parserDiagnostics: localParse.diagnostics, detectedFormat: localParse.format } : {}),
            privacyAcknowledged: true,
          },
          { onProgress, apiKey, model: activeModel },
        );
        await ensureSmoothProgressVisibility();
        const { applySchemaPatch } = await import('../model/patch');
        const builtModel = applySchemaPatch(baseSchemaForAI, patch);
        if (builtModel.entities.length > 0) {
          applyModelNow(builtModel, 'replace');
          return;
        }
        if (localParse && localParse.model.entities.length > 0) {
          applyModelNow(localParse.model, 'replace');
          return;
        }
        finishAndClose();
      } else {
        const patch = await requestEditProposal(
          {
            instruction: trimmed,
            schema: structuredClone(schema),
            privacyAcknowledged: true,
          },
          { onProgress, apiKey, model: activeModel },
        );
        await ensureSmoothProgressVisibility();
        if (patch.operations.length > 0) {
          applyOperations(patch.operations);
        } else {
          const deepOps = buildDeepSchemaExpansion(trimmed, schema);
          if (deepOps.length > 0) applyOperations(deepOps);
        }
        finishAndClose();
      }
    } catch {
      await ensureSmoothProgressVisibility();
      if (effectiveMode === 'edit') {
        if (isExplicitStructuredCode && localParse && localParse.model.entities.length >= 2) {
          applyModelNow(localParse.model, 'merge');
          return;
        }
        const deepOps = buildDeepSchemaExpansion(trimmed, schema);
        if (deepOps.length > 0) {
          applyOperations(deepOps);
        }
        finishAndClose();
        return;
      }
      if (localParse && localParse.model.entities.length > 0) {
        applyModelNow(localParse.model, 'replace');
      } else {
        const fallbackOps = buildDeepSchemaExpansion(trimmed, schema);
        if (fallbackOps.length > 0) applyOperations(fallbackOps);
        finishAndClose();
      }
    }
  };

  const cleanSubtext = sanitizeStatusMessage(progress?.message, locale);

  return (
    <section className="ai-chat-dialog-card" aria-label={copy.aria} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="ai-chat-dialog-header">
        <div className="ai-chat-dialog-title">
          <span className="ai-chat-badge-icon"><MessageSquarePlus size={18} /></span>
          <div>
            <span className="eyebrow">{copy.kicker}</span>
            <h3>{copy.title}</h3>
            <p>{copy.subtitle}</p>
          </div>
        </div>
        {!loading ? (
          <button className="icon-button dialog-close-btn" type="button" aria-label={copy.close} onClick={onClose}>
            <X size={18} />
          </button>
        ) : (
          <span className="operation-lock-pill" title={copy.lockedNotice}>
            <Lock size={13} />
            <span>{locale === 'ar' ? 'قيد التنفيذ' : 'Busy'}</span>
          </span>
        )}
      </header>

      {/* SINGLE MODE SWITCHER */}
      <div className="ai-mode-tabs" role="tablist" aria-label={copy.aria}>
        <button
          type="button"
          role="tab"
          disabled={loading}
          aria-selected={mode === 'interpret'}
          className={mode === 'interpret' ? 'ai-mode-tab selected' : 'ai-mode-tab'}
          onClick={() => { if (!loading) { setMode('interpret'); setError(null); } }}
        >
          <Wand2 size={14} />
          <span>{copy.createMode}</span>
        </button>
        <button
          type="button"
          role="tab"
          disabled={loading}
          aria-selected={mode === 'edit'}
          className={mode === 'edit' ? 'ai-mode-tab selected' : 'ai-mode-tab'}
          onClick={() => { if (!loading) { setMode('edit'); setError(null); } }}
        >
          <Sparkles size={14} />
          <span>{copy.editMode}</span>
        </button>
      </div>

      <label className="ai-instruction-label">
        <span>{mode === 'interpret' ? copy.promptLabel : copy.editLabel}</span>
        <textarea
          autoFocus
          disabled={loading}
          value={promptText}
          maxLength={100_000}
          onChange={(event) => setPromptText(event.target.value)}
          placeholder={mode === 'interpret' ? copy.promptPlaceholder : copy.editPlaceholder}
          rows={7}
        />
        <span className="ai-character-count">{promptText.length.toLocaleString()} / 100,000</span>
      </label>

      {/* ANIMATED MULTI-STEP AI PROGRESS TRACKER (NON-CANCELABLE) */}
      {loading && (
        <div className="ai-progress-card" role="status" aria-live="polite">
          <div className="ai-progress-top">
            <span className="ai-progress-title">
              <LoaderCircle size={16} className="spinning" />
              <strong>{progressStage === 1 ? copy.stage1 : progressStage === 2 ? copy.stage2 : copy.stage3}</strong>
            </span>
            <span className="ai-progress-pct">{progressPercent}%</span>
          </div>
          <div className="ai-progress-bar-track">
            <div className="ai-progress-bar-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="ai-progress-steps">
            <span className={`ai-step-item ${progressStage >= 1 ? 'is-done' : ''}`}>
              <CheckCircle2 size={12} /> {locale === 'ar' ? 'جاري الاتصال والتحليل' : 'Connect & Parse'}
            </span>
            <span className={`ai-step-item ${progressStage >= 2 ? 'is-done' : ''}`}>
              <CheckCircle2 size={12} /> {locale === 'ar' ? 'ربط العلاقات PK/FK' : 'Link PK/FK'}
            </span>
            <span className={`ai-step-item ${progressStage >= 3 ? 'is-done' : ''}`}>
              <CheckCircle2 size={12} /> {locale === 'ar' ? 'رسم مخطط ERD' : 'Render ERD'}
            </span>
          </div>
          {cleanSubtext && <small className="ai-progress-subtext">{cleanSubtext}</small>}
          <div className="operation-locked-banner">
            <Lock size={12} />
            <span>{copy.lockedNotice}</span>
          </div>
        </div>
      )}

      {error && <div className="ai-error" role="alert"><AlertTriangle size={14} /> <span>{error}</span></div>}
      {notice && <div className="ai-info" role="status"><Check size={14} /> <span>{notice}</span></div>}

      <div className="ai-dialog-footer">
        {!loading && (
          <button type="button" className="outline-button dialog-cancel-btn" onClick={onClose}>
            {locale === 'ar' ? 'إلغاء' : 'Cancel'}
          </button>
        )}
        <button
          type="button"
          className="primary-button ai-submit"
          disabled={loading || !promptText.trim()}
          onClick={() => void executeAIRequest()}
        >
          {loading ? <LoaderCircle size={15} className="spinning" /> : <Sparkles size={15} />}
          <span>
            {loading
              ? (locale === 'ar' ? 'جاري التنفيذ… يرجى الانتظار' : 'Processing… Please wait')
              : (mode === 'interpret' ? copy.generateButton : copy.editButton)}
          </span>
        </button>
      </div>
    </section>
  );
}
