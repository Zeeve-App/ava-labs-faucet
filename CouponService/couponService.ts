import Database from "better-sqlite3";
import { Mutex, MutexInterface } from "async-mutex";
import { CouponValidity } from "../types";

export type Coupon = {
    id: string;
    faucetConfigId: string;
    maxLimitAmount: number;
    consumedAmount: number;
    expiry: number;
    amountPerCoupon: number;
    reset: boolean;
    skipIpRateLimit?: boolean;
    skipWalletRateLimit?: boolean;
    skipCommonTokenDisbursalRateLimit?: boolean;
};

type CouponConfig = {
    IS_ENABLED: boolean;
    MAX_LIMIT_CAP: number;
};

function validateCouponData(
    coupon: any,
    couponConfig: CouponConfig,
    ignoreCouponLimitCheck = true
): Coupon | undefined {
    if (
        coupon.id &&
        coupon.faucetConfigId &&
        coupon.maxLimitAmount > 0 &&
        (ignoreCouponLimitCheck || coupon.maxLimitAmount <= couponConfig.MAX_LIMIT_CAP) &&
        coupon.consumedAmount <= coupon.maxLimitAmount &&
        coupon.expiry > 0
    ) {
        return coupon;
    }
    return undefined;
}

export class CouponService {
    private readonly mutex: MutexInterface;
    private readonly couponConfig: CouponConfig;
    private readonly db: Database.Database;
    coupons: Map<string, Coupon>;

    constructor(couponConfig: CouponConfig) {
        this.mutex = new Mutex();
        this.coupons = new Map<string, Coupon>();
        this.couponConfig = couponConfig;

        // Early exit if coupon system is disabled
        if (!couponConfig.IS_ENABLED) {
            // create in-memory store only
            this.db = new Database(":memory:");
            return;
        }

        // Initialize local DB
        this.db = new Database("./coupons.db");

        // Create table if not exists
        this.db
            .prepare(
                `CREATE TABLE IF NOT EXISTS coupons (
                    id TEXT PRIMARY KEY,
                    faucetConfigId TEXT,
                    maxLimitAmount INTEGER,
                    consumedAmount INTEGER,
                    expiry INTEGER,
                    amountPerCoupon INTEGER,
                    reset INTEGER,
                    skipIpRateLimit INTEGER,
                    skipWalletRateLimit INTEGER,
                    skipCommonTokenDisbursalRateLimit INTEGER
                )`
            )
            .run();

        // Initial sync
        this.syncCoupons();

        // Periodically sync between memory and DB
        setInterval(() => {
            this.syncCoupons();
        }, 10_000);
    }

    /**
     * Syncs coupons in memory with SQLite DB
     */
    private async syncCoupons(): Promise<void> {
        const stmt = this.db.prepare("SELECT * FROM coupons");
        const dbCoupons = stmt.all() as any[];

        const dbItemSet = new Set<string>();

        // Load coupons from DB
        dbCoupons.forEach((item) => {
            const coupon = validateCouponData(item, this.couponConfig, true);
            if (coupon) {
                dbItemSet.add(coupon.id);

                if (this.coupons.get(coupon.id) === undefined || coupon.reset) {
                    coupon.reset = false;
                    this.coupons.set(coupon.id, coupon);
                }
            } else {
                console.log(
                    JSON.stringify({
                        date: new Date(),
                        type: "InvalidCouponFetched",
                        item,
                    })
                );
            }
        });

        // Remove coupons deleted from DB
        for (const [id] of this.coupons.entries()) {
            if (!dbItemSet.has(id)) {
                this.coupons.delete(id);
            }
        }

        // Update coupon usage in DB
        await this.batchUpdateCoupons();
    }

    /**
     * Batch update all coupons from memory to DB
     */
    async batchUpdateCoupons(): Promise<void> {
        const stmt = this.db.prepare(
            `INSERT INTO coupons (
                id, faucetConfigId, maxLimitAmount, consumedAmount,
                expiry, amountPerCoupon, reset,
                skipIpRateLimit, skipWalletRateLimit, skipCommonTokenDisbursalRateLimit
            ) VALUES (
                @id, @faucetConfigId, @maxLimitAmount, @consumedAmount,
                @expiry, @amountPerCoupon, @reset,
                @skipIpRateLimit, @skipWalletRateLimit, @skipCommonTokenDisbursalRateLimit
            )
            ON CONFLICT(id) DO UPDATE SET
                consumedAmount = excluded.consumedAmount,
                reset = excluded.reset`
        );

        for (const coupon of this.coupons.values()) {
            stmt.run({
                ...coupon,
                reset: coupon.reset ? 1 : 0,
                skipIpRateLimit: coupon.skipIpRateLimit ? 1 : 0,
                skipWalletRateLimit: coupon.skipWalletRateLimit ? 1 : 0,
                skipCommonTokenDisbursalRateLimit: coupon.skipCommonTokenDisbursalRateLimit
                    ? 1
                    : 0,
            });
        }
    }

    /**
     * Consume coupon amount
     */
    async consumeCouponAmount(
        id: string,
        faucetConfigId: string,
        amount: number
    ): Promise<CouponValidity> {
        if (!this.couponConfig.IS_ENABLED) return { isValid: true, amount };

        const release = await this.mutex.acquire();
        try {
            const coupon = this.coupons.get(id);
            const couponAmount = coupon?.amountPerCoupon ?? amount;

            if (
                coupon &&
                coupon.faucetConfigId === faucetConfigId &&
                coupon.expiry > Date.now() / 1000 &&
                coupon.consumedAmount + couponAmount < coupon.maxLimitAmount
            ) {
                coupon.consumedAmount += couponAmount;
                return { isValid: true, amount: couponAmount };
            }

            return { isValid: false, amount: couponAmount };
        } finally {
            release();
        }
    }

    /**
     * Reclaim previously consumed coupon amount
     */
    async reclaimCouponAmount(id: string, amount: number): Promise<void> {
        const release = await this.mutex.acquire();

        try {
            const coupon = this.coupons.get(id);
            if (
                coupon &&
                coupon.expiry > Date.now() / 1000 &&
                coupon.consumedAmount - amount > 0
            ) {
                coupon.consumedAmount -= amount;
            }
        } finally {
            release();
        }
    }

    /**
     * Get coupon from in-memory cache
     */
    getCoupon(id: string): Coupon | undefined {
        return this.coupons.get(id);
    }
}
