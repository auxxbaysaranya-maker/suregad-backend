import { z } from "zod";
import { CHECK_RESULTS, PRODUCT_CONDITIONS, SELLER_TYPES } from "./index";

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const addressSchema = z.object({
  label: z.string().trim().min(1).max(40).default("Home"),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(8).max(20),
  line1: z.string().trim().min(3).max(160),
  line2: z.string().trim().max(160).optional(),
  city: z.string().trim().min(2).max(80),
  district: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80).default("Kerala"),
  pincode: z.string().trim().regex(/^\d{6}$/, "PIN code must be 6 digits"),
  coordinates: z
    .object({
      lat: z.number().gte(-90).lte(90),
      lng: z.number().gte(-180).lte(180),
    })
    .optional(),
});

export const warrantySchema = z.object({
  available: z.boolean(),
  until: z.string().optional(),
  notes: z.string().max(300).optional(),
});

export const smartphoneSpecsSchema = z.object({
  brand: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  storageGb: z.number().positive().max(4096),
  ramGb: z.number().positive().max(256),
  colour: z.string().trim().min(1).max(40),
  processor: z.string().trim().max(120).optional(),
  displayInches: z.number().positive().max(20).optional(),
  batteryMah: z.number().positive().max(20000).optional(),
  camera: z.string().trim().max(200).optional(),
  os: z.string().trim().max(80).optional(),
  purchaseDate: z.string().optional(),
  warranty: warrantySchema.optional(),
});

export const laptopSpecsSchema = z.object({
  brand: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  processor: z.string().trim().min(1).max(120),
  processorGeneration: z.string().trim().max(40).optional(),
  ramGb: z.number().positive().max(512),
  storageGb: z.number().positive().max(8192),
  gpu: z.string().trim().max(120).optional(),
  displayInches: z.number().positive().max(24).optional(),
  resolution: z.string().trim().max(40).optional(),
  battery: z.string().trim().max(80).optional(),
  os: z.string().trim().max(80).optional(),
  purchaseDate: z.string().optional(),
  warranty: warrantySchema.optional(),
});

export const productWriteSchema = z.object({
  categorySlug: z.enum(["smartphones", "laptops"]),
  sellerType: z.enum(SELLER_TYPES),
  businessId: objectIdSchema.optional(),
  title: z.string().trim().min(4).max(140),
  description: z.string().trim().min(10).max(8000),
  condition: z.enum(PRODUCT_CONDITIONS),
  pricePaise: z.number().int().positive().max(50_000_000),
  specs: z.record(z.unknown()),
  imageKeys: z.array(z.string().min(3)).max(20).default([]),
  location: addressSchema.pick({
    city: true,
    district: true,
    state: true,
    pincode: true,
    coordinates: true,
  }),
  imei: z.string().trim().min(14).max(18).optional(),
  serialNumber: z.string().trim().min(4).max(64).optional(),
  submit: z.boolean().default(true),
});

export const inspectionResultSchema = z.object({
  key: z.string().min(1),
  result: z.enum(CHECK_RESULTS),
  comment: z.string().max(1000).optional(),
  evidenceIds: z.array(objectIdSchema).default([]),
});

export type AddressInput = z.infer<typeof addressSchema>;
export type ProductWriteInput = z.infer<typeof productWriteSchema>;
