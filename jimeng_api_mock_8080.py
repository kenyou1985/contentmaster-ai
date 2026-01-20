"""
即梦API服务 - 运行在8080端口
使用SESSION_ID调用真实的即梦API生成图片
只使用即梦自己的API，不使用其他API
"""
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import sys
import io
import os

# 修复Windows控制台编码问题
if sys.platform == 'win32':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
    except:
        pass

app = Flask(__name__)
CORS(app)  # 允许跨域请求

# ===================== 配置项 =====================
# 真实即梦API地址（从环境变量读取，默认使用3000端口）
# 如果即梦有在线API，请设置环境变量 JIMENG_REAL_API_URL
# 例如: JIMENG_REAL_API_URL=https://api.jimeng.ai
# 如果即梦服务在本地其他端口，也可以设置
# 例如: JIMENG_REAL_API_URL=http://localhost:3030
# 默认使用本地3030端口的即梦API服务
JIMENG_REAL_API_URL = os.getenv('JIMENG_REAL_API_URL', 'http://localhost:3030')
# 请求超时设置（秒）
CONNECT_TIMEOUT = int(os.getenv('CONNECT_TIMEOUT', '10'))  # 连接超时
READ_TIMEOUT = int(os.getenv('READ_TIMEOUT', '600'))  # 读取超时（10分钟，适应长时间生成）
# ==================================================

def call_real_jimeng_api(prompt, num_images, width, height, session_id):
    """
    调用真实的即梦API生成图片
    使用SESSION_ID进行认证
    只使用即梦自己的API，不使用其他API
    """
    # 如果没有配置真实API地址，返回错误
    if not JIMENG_REAL_API_URL:
        raise Exception(
            "未配置真实即梦API地址\n"
            "请设置环境变量 JIMENG_REAL_API_URL\n"
            "例如:\n"
            "  Windows PowerShell: $env:JIMENG_REAL_API_URL='https://api.jimeng.ai'\n"
            "  Windows CMD: set JIMENG_REAL_API_URL=https://api.jimeng.ai\n"
            "  Linux/Mac: export JIMENG_REAL_API_URL=https://api.jimeng.ai\n"
            "\n"
            "如何找到真实的即梦API地址:\n"
            "  1. 查看即梦官方文档\n"
            "  2. 在即梦Web端按F12，查看Network请求中的API地址\n"
            "  3. 查看即梦Docker容器的端口映射"
        )
    
    try:
        url = f"{JIMENG_REAL_API_URL}/v1/images/generations"
        
        # 确保URL格式正确
        if not url.startswith('http'):
            raise Exception(f"API地址格式错误: {JIMENG_REAL_API_URL}")
        
        headers = {
            "Authorization": f"Bearer {session_id}",
            "Content-Type": "application/json"
        }
        data = {
            "prompt": prompt,
            "num_images": num_images,
            "width": width,
            "height": height
        }
        
        print(f"[即梦API] 调用真实即梦API: {url}")
        print(f"[即梦API] 使用SESSION_ID: {session_id[:20]}...")
        print(f"[即梦API] 请求参数: prompt={prompt[:50]}..., num_images={num_images}, size={width}x{height}")
        
        # 发送请求（较长的超时时间，图片生成可能需要时间）
        response = requests.post(
            url, 
            headers=headers, 
            json=data, 
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT)
        )
        
        # 检查HTTP状态
        response.raise_for_status()
        
        # 解析响应（按照jm.py期望的格式：{"data": [{"url": "xxx"}, ...]}）
        result = response.json()
        
        if "data" in result and len(result["data"]) > 0:
            # 提取图片URL列表
            image_urls = [item.get("url") for item in result["data"] if item.get("url")]
            print(f"[即梦API] [成功] 调用成功，返回 {len(image_urls)} 张真实图片")
            for i, url in enumerate(image_urls[:3], 1):  # 只打印前3张
                print(f"  [{i}] {url[:80]}...")
            if len(image_urls) > 3:
                print(f"  ... 还有 {len(image_urls) - 3} 张图片")
            
            # 返回与jm.py兼容的格式
            return {
                "data": [{"url": url} for url in image_urls],
                "status": "success"
            }
        else:
            error_msg = f"响应无图片数据：{result}"
            print(f"[即梦API] [失败] {error_msg}")
            raise Exception(error_msg)
            
    except requests.exceptions.HTTPError as e:
        error_msg = f"HTTP错误: {e.response.status_code}"
        try:
            error_detail = e.response.json()
            error_msg = error_detail.get('error', error_detail.get('message', error_msg))
        except:
            error_text = e.response.text[:500]
            if error_text:
                error_msg = f"{error_msg} - {error_text}"
        
        print(f"[即梦API] [失败] {error_msg}")
        
        # 特殊处理401错误（SESSION_ID无效）
        if e.response.status_code == 401:
            raise Exception(f"SESSION_ID无效或已过期，请检查SESSION_ID是否正确")
        elif e.response.status_code == 403:
            raise Exception(f"访问被拒绝，SESSION_ID可能没有权限")
        else:
            raise Exception(f"即梦API调用失败: {error_msg}")
            
    except requests.exceptions.ConnectTimeout:
        error_msg = f"连接超时: 无法在{CONNECT_TIMEOUT}秒内连接到 {JIMENG_REAL_API_URL}"
        print(f"[即梦API] [失败] {error_msg}")
        raise Exception(error_msg)
        
    except requests.exceptions.ConnectionError as e:
        error_msg = str(e)
        print(f"[即梦API] [失败] 连接失败: 无法连接到 {JIMENG_REAL_API_URL}")
        
        if "Connection refused" in error_msg or "10061" in error_msg:
            detailed_msg = (
                f"连接被拒绝: 即梦服务未在 {JIMENG_REAL_API_URL} 运行\n"
                f"请检查:\n"
                f"  1. 即梦服务是否已启动\n"
                f"  2. API地址是否正确\n"
                f"  3. 如果使用Docker，检查容器状态: docker ps"
            )
            raise Exception(f"连接失败: {detailed_msg}")
        else:
            raise Exception(f"连接失败: {error_msg}")
        
    except requests.exceptions.ReadTimeout:
        error_msg = f"读取超时: API响应时间超过{READ_TIMEOUT}秒"
        print(f"[即梦API] [超时] {error_msg}")
        print(f"[即梦API] 图片生成可能需要更长时间，特别是生成 {num_images} 张图片")
        raise Exception(error_msg)
        
    except Exception as e:
        error_msg = str(e)
        print(f"[即梦API] [异常] {error_msg}")
        import traceback
        traceback.print_exc()
        raise

@app.route('/health', methods=['GET'])
def health():
    """健康检查接口"""
    return jsonify({
        "status": "ok",
        "service": "即梦API真实服务",
        "port": 8080,
        "jimeng_real_api_url": JIMENG_REAL_API_URL or "未配置",
        "note": "使用SESSION_ID调用真实即梦API生成图片，不使用其他API"
    }), 200

@app.route('/v1/images/generations', methods=['POST', 'OPTIONS'])
def generate_images():
    """
    即梦API图片生成接口
    使用SESSION_ID调用真实即梦API
    只使用即梦自己的API，不使用其他API
    """
    # 处理OPTIONS请求（CORS预检）
    if request.method == 'OPTIONS':
        return jsonify({}), 200
    
    try:
        # 获取请求数据
        data = request.get_json() or {}
        prompt = data.get('prompt', '')
        num_images = data.get('num_images', 1)
        width = data.get('width', 1080)
        height = data.get('height', 1920)
        
        # 获取Authorization头（即梦SESSION_ID）
        auth_header = request.headers.get('Authorization', '')
        session_id = auth_header.replace('Bearer ', '') if auth_header.startswith('Bearer ') else ''
        
        # 验证必需参数
        if not session_id:
            return jsonify({
                "error": "缺少SESSION_ID，请在请求头中提供 Authorization: Bearer <SESSION_ID>",
                "status": "error"
            }), 400
        
        if not prompt:
            return jsonify({
                "error": "缺少提示词，请在请求体中提供 prompt",
                "status": "error"
            }), 400
        
        print(f"\n{'='*60}")
        print(f"[即梦API] 收到生成请求")
        print(f"  提示词: {prompt}")
        print(f"  数量: {num_images}")
        print(f"  尺寸: {width}x{height}")
        print(f"  SESSION_ID: {session_id[:20]}...")
        print(f"  真实即梦API地址: {JIMENG_REAL_API_URL or '未配置'}")
        print(f"{'='*60}")
        
        # 调用真实即梦API
        result = call_real_jimeng_api(prompt, num_images, width, height, session_id)
        
        if result and result.get('data'):
            print(f"[即梦API] [成功] 成功生成 {len(result['data'])} 张真实图片")
            print(f"{'='*60}\n")
            # 返回与jm.py兼容的格式
            return jsonify(result), 200
        else:
            error_msg = "即梦API返回的数据格式不正确"
            print(f"[即梦API] [失败] {error_msg}")
            print(f"{'='*60}\n")
            return jsonify({
                "error": error_msg,
                "status": "error"
            }), 500
        
    except Exception as e:
        error_msg = str(e)
        print(f"[错误] {error_msg}")
        print(f"{'='*60}\n")
        
        # 提取错误信息（可能包含多行）
        error_lines = error_msg.split('\n')
        main_error = error_lines[0] if error_lines else error_msg
        
        # 返回友好的错误信息
        return jsonify({
            "error": main_error,
            "status": "error",
            "suggestion": error_msg if '\n' in error_msg else f"请检查：1. SESSION_ID是否有效 2. 真实即梦API地址是否正确 ({JIMENG_REAL_API_URL or '未配置'}) 3. 网络连接是否正常",
            "jimeng_real_api_url": JIMENG_REAL_API_URL or "未配置"
        }), 500

@app.route('/', methods=['GET'])
def index():
    """首页"""
    return jsonify({
        "service": "即梦API真实服务",
        "version": "1.0.0",
        "description": "使用SESSION_ID调用真实即梦API生成图片，不使用其他API",
        "endpoints": {
            "POST /v1/images/generations": "生成图片（需要SESSION_ID）",
            "GET /health": "健康检查"
        },
        "config": {
            "jimeng_real_api_url": JIMENG_REAL_API_URL or "未配置",
            "note": "需要设置环境变量 JIMENG_REAL_API_URL 指向真实的即梦API地址"
        }
    }), 200

if __name__ == '__main__':
    print("\n" + "="*60)
    print("即梦API真实服务启动中...")
    print("="*60)
    print("服务地址: http://localhost:8080")
    print("API端点: POST http://localhost:8080/v1/images/generations")
    print("健康检查: GET http://localhost:8080/health")
    print("="*60)
    
    if JIMENG_REAL_API_URL:
        print(f"真实即梦API地址: {JIMENG_REAL_API_URL}")
        print("[模式] 使用真实即梦API生成图片")
    else:
        print("[警告] 未配置真实即梦API地址")
        print("[提示] 请设置环境变量 JIMENG_REAL_API_URL")
        print("[示例] Windows PowerShell: $env:JIMENG_REAL_API_URL='https://api.jimeng.ai'")
        print("[示例] Windows CMD: set JIMENG_REAL_API_URL=https://api.jimeng.ai")
        print("\n如何找到真实的即梦API地址:")
        print("  1. 查看即梦官方文档")
        print("  2. 在即梦Web端按F12，查看Network请求中的API地址")
        print("  3. 查看即梦Docker容器的端口映射")
    
    print("="*60)
    print("\n说明:")
    print("  - 此服务使用SESSION_ID调用真实即梦API生成图片")
    print("  - 只使用即梦自己的API，不使用其他API（如yunwu.ai）")
    print("  - 需要在请求头中提供: Authorization: Bearer <SESSION_ID>")
    print("  - 需要配置真实的即梦API地址（环境变量 JIMENG_REAL_API_URL）")
    print("="*60)
    print("\n提示: 在网站中使用即梦模型生成图片")
    print("按 Ctrl+C 停止服务器\n")
    print("="*60 + "\n")
    
    # 启动服务器
    app.run(host='0.0.0.0', port=8080, debug=True)
