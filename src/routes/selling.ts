import { Router, type Request } from "express";
import { Types } from "mongoose";
import { requireUser } from "../middleware/auth";
import { asyncHandler, sendData } from "../common/http";
import { notFound } from "../common/errors";
import { Product } from "../models/catalog.model";
import { createIndividualListing, markSold, presentOwnListing, renewListing, sellingOverview } from "../services/selling.service";

/** Selling from an ordinary marketplace account: no panel, sales happen in chat. */
export const selling = Router();

async function own(req: Request) {
  const id = String(req.params.id);
  const product = Types.ObjectId.isValid(id) ? await Product.findOne({ _id: id, sellerUserId: req.user!._id, sellerType: "individual", deletedAt: null }) : null;
  if (!product) throw notFound("Listing not found.");
  return product;
}

selling.get("/me/selling", requireUser, asyncHandler(async (req, res) => sendData(res, await sellingOverview(String(req.user!._id)))));

selling.post("/me/selling", requireUser, asyncHandler(async (req, res) => sendData(res, await createIndividualListing(req, req.body), undefined, 201)));

selling.get("/me/selling/:id", requireUser, asyncHandler(async (req, res) => sendData(res, presentOwnListing((await own(req)).toObject()))));

selling.post("/me/selling/:id/sold", requireUser, asyncHandler(async (req, res) => sendData(res, presentOwnListing((await markSold(req, await own(req), req.body)).toObject()))));

selling.post("/me/selling/:id/renew", requireUser, asyncHandler(async (req, res) => sendData(res, presentOwnListing((await renewListing(req, await own(req))).toObject()))));
