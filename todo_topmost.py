"""
待办事项置顶小窗 — Windows 桌面悬浮窗
用法: python todo_topmost.py
依赖: pip install pywebview

功能:
  - 打开一个 Windows 置顶悬浮窗显示待办事项
  - 窗口始终在最上层 (always on top)
  - 可拖拽、缩放，半透明背景
  - 数据与主程序同步 (通过 API)
"""

import sys
import argparse


def main():
    try:
        import webview
    except ImportError:
        print("❌ 请先安装 pywebview:")
        print("   pip install pywebview")
        sys.exit(1)

    parser = argparse.ArgumentParser(description="待办事项置顶小窗")
    parser.add_argument("--host", default="10.118.81.165", help="主程序地址 (默认 localhost)")
    parser.add_argument("--port", default=8888, type=int, help="主程序端口 (默认 8888)")
    parser.add_argument("--width", default=340, type=int, help="窗口宽度")
    parser.add_argument("--height", default=500, type=int, help="窗口高度")
    parser.add_argument("--x", default=None, type=int, help="窗口 X 位置")
    parser.add_argument("--y", default=None, type=int, help="窗口 Y 位置")
    parser.add_argument("--opacity", default=0.95, type=float, help="窗口透明度 0~1")
    args = parser.parse_args()

    url = f"http://{args.host}:{args.port}/todo-float"

    window = webview.create_window(
        title="📋 待办事项",
        url=url,
        width=args.width,
        height=args.height,
        x=args.x,
        y=args.y,
        resizable=True,
        on_top=True,
        frameless=False,
        easy_drag=True,
        background_color="#1a1b2e",
    )

    # 设置透明度 (Windows)
    def on_shown():
        try:
            if sys.platform == "win32":
                import ctypes
                from ctypes import wintypes
                GWL_EXSTYLE = -20
                WS_EX_LAYERED = 0x80000
                LWA_ALPHA = 0x2
                hwnd = window.hwnd if hasattr(window, 'hwnd') else None
                if hwnd:
                    style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                    ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED)
                    ctypes.windll.user32.SetLayeredWindowAttributes(
                        hwnd, 0, int(args.opacity * 255), LWA_ALPHA
                    )
        except Exception:
            pass

    if args.opacity < 1.0:
        window.events.shown += on_shown

    print(f"🚀 待办事项悬浮窗已启动: {url}")
    print(f"   窗口大小: {args.width}x{args.height}, 透明度: {args.opacity}")
    print(f"   关闭窗口即退出")

    webview.start()


if __name__ == "__main__":
    main()
