"""测试能否通过 COM 在 SW Code Patch Review 数据库中创建文档"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import win32com.client
from datetime import datetime

import getpass
pwd = getpass.getpass("Notes Password: ")
session = win32com.client.Dispatch("Lotus.NotesSession")
session.Initialize(pwd)

print(f"当前用户: {session.UserName}")

db = session.GetDatabase("Arc-Ap2/Arcadyan", r"RD\CodePatchReview.nsf")
if not db.IsOpen:
    db.Open("", "")

print(f"数据库: {db.Title}")
print(f"文档数: {db.AllDocuments.Count}")

# 尝试创建一个测试文档
try:
    doc = db.CreateDocument
    doc.ReplaceItemValue("Form", "MainDepose")
    doc.ReplaceItemValue("DocNo", "TEST_DELETE_ME")
    doc.ReplaceItemValue("Status", "1")
    doc.ReplaceItemValue("ProjectName", "TEST")
    
    dt = session.CreateDateTime(datetime.now().strftime("%Y/%m/%d %H:%M:%S"))
    doc.ReplaceItemValue("CreateDate", dt)
    
    doc.ComputeWithForm(False, False)
    success = doc.Save(True, False)
    
    if success:
        print("")
        print("[OK] 创建成功! 你有写入权限。")
        print(f"   UniversalID: {doc.UniversalID}")
        
        # 立即删除测试文档
        doc.Remove(True)
        print("   测试文档已删除。")
    else:
        print("[FAIL] 保存失败")
        
except Exception as e:
    print(f"[FAIL] 创建失败: {e}")
    print("   你可能没有写入权限")
