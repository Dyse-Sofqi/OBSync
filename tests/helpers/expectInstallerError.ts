import { expect } from "vitest";
import {
    InstallerError,
    type InstallerErrorDetail,
} from "../../src/features/installer/errors";

/**
 * 断言操作抛出带指定类型码的安装器错误。
 *
 * 刻意**不**断言消息文本 —— 文案现在来自 locale，`message` 里只有技术性描述。
 * 断言类型码才稳定：改文案不该让测试变红，而改类型码应该。
 *
 * `await` 对同步返回值也成立，所以同一个助手能覆盖同步抛错与 Promise 拒绝。
 */
export async function expectInstallerError(
    action: () => unknown,
    kind: InstallerErrorDetail["kind"]
): Promise<InstallerError> {
    try {
        await action();
    } catch (err) {
        expect(err).toBeInstanceOf(InstallerError);
        const error = err as InstallerError;
        expect(error.detail.kind).toBe(kind);
        return error;
    }
    throw new Error(`期望抛出 ${kind}，但没有抛错`);
}
