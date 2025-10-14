import Database from "better-sqlite3";
import { getNonce } from "./utils/mainnetBalanceCheck";

const DB_PATH = "./mainnet_check_tracker.db";
const MAINNET_CHECK_TRACKER_TABLE = "mainnet_check_tracker";
const MAX_ADDRESS_CHECK_COUNT = 3;

type AddressStatus = {
    checkCount: number,
    lastUsedNonce: number,
};

type ResponseType = {
    isValid: boolean,
    internalError: boolean,
    message: string,
};

export class MainnetCheckService {
    private readonly db: Database.Database;
    private readonly RPC: string;

    constructor(rpc: string) {
        this.RPC = rpc;
        this.db = new Database(DB_PATH);

        // Initialize table if not exists
        this.db
            .prepare(
                `CREATE TABLE IF NOT EXISTS ${MAINNET_CHECK_TRACKER_TABLE} (
                    address TEXT PRIMARY KEY,
                    checkCount INTEGER,
                    lastUsedNonce INTEGER
                )`
            )
            .run();
    }

    /**
     * Main logic (same as before)
     */
    async checkAddressValidity(address: string): Promise<ResponseType> {
        const response: ResponseType = { isValid: false, internalError: false, message: "" };

        let addressStatus = this.getAddressStatus(address);
        if (!addressStatus) {
            addressStatus = await this.updateAddressStatus(address);
            if (!addressStatus) {
                response.internalError = true;
                return response;
            }
        }

        if (addressStatus.checkCount < MAX_ADDRESS_CHECK_COUNT) {
            this.updateAddressStatus(address, addressStatus.checkCount + 1, addressStatus.lastUsedNonce);
            response.isValid = true;
        } else {
            const currentNonce = await getNonce(this.RPC, address);
            if (!currentNonce && currentNonce !== 0) {
                response.internalError = true;
                return response;
            }
            const diff = currentNonce - addressStatus.lastUsedNonce;
            if (diff > 0) {
                const updatedCheckCount = Math.max(0, addressStatus.checkCount - diff) + 1;
                this.updateAddressStatus(address, updatedCheckCount, currentNonce);
                response.isValid = true;
            }
        }

        return response;
    }

    /**
     * Get address status from SQLite
     */
    getAddressStatus(address: string): AddressStatus | undefined {
        try {
            const stmt = this.db.prepare(
                `SELECT checkCount, lastUsedNonce FROM ${MAINNET_CHECK_TRACKER_TABLE} WHERE address = ?`
            );
            const row:any = stmt.get(address);
            console.log('sqlite-row',row);
            return row ? { checkCount: row.checkCount, lastUsedNonce: row.lastUsedNonce } : undefined;
        } catch (error) {
            console.error(JSON.stringify({
                date: new Date(),
                type: "GetAddressStatusError",
                item: error,
            }));
        }
    }

    /**
     * Insert or update address status in SQLite
     */
    async updateAddressStatus(
        address: string,
        checkCount: number = 0,
        nonce?: number
    ): Promise<AddressStatus | undefined> {
        try {
            if (!nonce && nonce !== 0) {
                const currentNonce = await getNonce(this.RPC, address);
                if (!currentNonce && currentNonce !== 0) return;
                nonce = currentNonce;
            }

            const stmt = this.db.prepare(
                `INSERT INTO ${MAINNET_CHECK_TRACKER_TABLE} (address, checkCount, lastUsedNonce)
                 VALUES (?, ?, ?)
                 ON CONFLICT(address)
                 DO UPDATE SET checkCount = excluded.checkCount, lastUsedNonce = excluded.lastUsedNonce`
            );
            stmt.run(address, checkCount, nonce);

            return { checkCount, lastUsedNonce: nonce };
        } catch (error) {
            console.error(JSON.stringify({
                date: new Date(),
                type: "UpdateAddressStatusError",
                item: error,
            }));
        }
    }
}
