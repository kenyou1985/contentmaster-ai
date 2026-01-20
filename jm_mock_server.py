"""
即梦API Mock服务器 - 基于jm.py重构
不依赖Docker，直接使用SESSION_ID调用真实即梦API
"""
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import os

app = Flask(__name__)
CORS(app)  # 允许跨域请求

# ===================== 配置项 =====================
# 真实即梦API地址（从环境变量读取，或使用默认值）
# 如果您的即梦服务在其他地址，请设置环境变量 JIMENG_API_BASE_URL
JIMENG_API_BASE_URL = os.getenv('JIMENG_API_BASE_URL', 'http://localhost:5100')
# 请求超时设置（秒）
CONNECT_TIMEOUT = int(os.getenv('CONNECT_TIMEOUT', '10'))  # 连接超时
READ_TIMEOUT = int(os.getenv('READ_TIMEOUT', '600'))  # 读取超时（10分钟，适应长时间生成）
# ==================================================

def call_real_jimeng_api(prompt, num_images, width, height, session_id):
    """
    调用真实即梦API生成图片（基于jm.py的实现）
    使用SESSION_ID进行认证
    
    :param prompt: 生图提示词
    :param num_images: 生成数量
    :param width: 图片宽度
    :param height: 图片高度
    :param session_id: 即梦SESSION_ID
    :return: 图片URL列表或None
    """
    try:
        # 检查是否试图调用自己（避免循环调用）
        if 'localhost' in JIMENG_API_BASE_URL.lower() or '127.0.0.1' in JIMENG_API_BASE_URL:
            if ':5100' in JIMENG_API_BASE_URL or JIMENG_API_BASE_URL.endswith(':5100'):
                raise Exception(
                    f"❌ 配置错误: Mock服务器不能调用自己的地址 ({JIMENG_API_BASE_URL})\n"
                    f"Mock服务器运行在 localhost:5100，但它试图调用同一个地址\n"
                    f"请设置环境变量 JIMENG_API_BASE_URL 指向真实的即梦服务地址\n"
                    f"例如:\n"
                    f"  Windows PowerShell: $env:JIMENG_API_BASE_URL='http://localhost:8080'\n"
                    f"  Windows CMD: set JIMENG_API_BASE_URL=http://localhost:8080\n"
                    f"  Linux/Mac: export JIMENG_API_BASE_URL=http://localhost:8080\n"
                    f"然后重启Mock服务器"
                )
        
        url = f"{JIMENG_API_BASE_URL}/v1/images/generations"
        
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
        
        print(f"[即梦API] 调用即梦API: {url}")
        print(f"[即梦API] 使用SESSION_ID: {session_id[:20]}...")
        print(f"[即梦API] 请求参数: prompt={prompt[:50]}..., num_images={num_images}, size={width}x{height}")
        
        # 发送请求（使用配置的超时时间）
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
            print(f"[即梦API] ✅ 调用成功，返回 {len(image_urls)} 张图片")
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
            print(f"[即梦API] ❌ {error_msg}")
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
        
        print(f"[即梦API] ❌ {error_msg}")
        
        # 特殊处理401错误（SESSION_ID无效）
        if e.response.status_code == 401:
            raise Exception(f"SESSION_ID无效或已过期，请检查SESSION_ID是否正确")
        elif e.response.status_code == 403:
            raise Exception(f"访问被拒绝，SESSION_ID可能没有权限")
        else:
            raise Exception(f"即梦API调用失败: {error_msg}")
            
    except requests.exceptions.ConnectTimeout:
        error_msg = f"连接超时: 无法在{CONNECT_TIMEOUT}秒内连接到 {JIMENG_API_BASE_URL}"
        print(f"[即梦API] ❌ {error_msg}")
        print(f"[即梦API] 请检查:")
        print(f"  1. 网络连接是否正常")
        print(f"  2. API地址是否正确 (当前: {JIMENG_API_BASE_URL})")
        print(f"  3. 即梦服务是否正在运行")
        print(f"  4. 如果即梦API在其他地址，请设置环境变量: JIMENG_API_BASE_URL")
        raise Exception(error_msg)
        
    except requests.exceptions.ConnectionError as e:
        error_msg = str(e)
        print(f"[即梦API] ❌ 连接失败: 无法连接到 {JIMENG_API_BASE_URL}")
        
        # 详细的错误诊断
        if "Connection refused" in error_msg or "10061" in error_msg:
            port = JIMENG_API_BASE_URL.split(':')[-1] if ':' in JIMENG_API_BASE_URL else 'N/A'
            detailed_msg = (
                f"连接被拒绝: 即梦服务未在 {JIMENG_API_BASE_URL} 运行\n"
                f"\n请检查:\n"
                f"  1. 即梦服务是否已启动\n"
                f"  2. 端口是否正确（当前配置: {port}）\n"
                f"  3. 如果使用Docker，检查容器状态:\n"
                f"     docker ps\n"
                f"     docker logs <容器名>\n"
                f"  4. 检查端口是否被占用:\n"
                f"     netstat -an | findstr \"{port}\"\n"
                f"  5. 如果即梦服务在其他地址，请设置:\n"
                f"     Windows PowerShell: $env:JIMENG_API_BASE_URL='http://正确的地址:端口'\n"
                f"     Windows CMD: set JIMENG_API_BASE_URL=http://正确的地址:端口"
            )
            print(f"[即梦API] {detailed_msg}")
            raise Exception(f"连接失败: {detailed_msg}")
        elif "Name or service not known" in error_msg or "nodename nor servname provided" in error_msg:
            detailed_msg = (
                f"无法解析主机名: 请检查API地址是否正确\n"
                f"当前地址: {JIMENG_API_BASE_URL}\n"
                f"请确认地址格式正确，例如: http://localhost:8080"
            )
            print(f"[即梦API] {detailed_msg}")
            raise Exception(f"连接失败: {detailed_msg}")
        else:
            detailed_msg = (
                f"网络连接失败: {error_msg}\n"
                f"请检查:\n"
                f"  1. 即梦服务是否在 {JIMENG_API_BASE_URL} 运行\n"
                f"  2. 网络连接是否正常\n"
                f"  3. API地址是否正确"
            )
            print(f"[即梦API] 错误详情: {error_msg}")
            raise Exception(f"连接失败: {detailed_msg}")
        
    except requests.exceptions.ReadTimeout:
        error_msg = f"读取超时: API响应时间超过{READ_TIMEOUT}秒"
        print(f"[即梦API] ⏱️  {error_msg}")
        print(f"[即梦API] 图片生成可能需要更长时间，特别是生成 {num_images} 张图片")
        print(f"[即梦API] 建议：减少同时生成图片的数量，或检查即梦服务是否正常")
        raise Exception(error_msg)
        
    except requests.exceptions.Timeout:
        error_msg = f"请求超时: 超过{READ_TIMEOUT}秒"
        print(f"[即梦API] ⏱️  {error_msg}")
        raise Exception(error_msg)
        
    except Exception as e:
        error_msg = str(e)
        print(f"[即梦API] ❌ 调用异常: {error_msg}")
        import traceback
        traceback.print_exc()
        raise

@app.route('/v1/images/generations', methods=['POST', 'OPTIONS'])
def generate_images():
    """
    即梦API图片生成接口（兼容jm.py的调用方式）
    使用SESSION_ID调用真实即梦API
    """
    # 处理OPTIONS请求（CORS预检）
    if request.method == 'OPTIONS':
        return jsonify({}), 200
    
    try:
        # 获取请求数据（兼容jm.py的格式）
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
        print(f"  即梦API地址: {JIMENG_API_BASE_URL}")
        print(f"{'='*60}")
        
        # 调用真实即梦API
        result = call_real_jimeng_api(prompt, num_images, width, height, session_id)
        
        if result and result.get('data'):
            print(f"[即梦API] ✅ 成功生成 {len(result['data'])} 张图片")
            print(f"{'='*60}\n")
            # 返回与jm.py兼容的格式
            return jsonify(result), 200
        else:
            error_msg = "即梦API返回的数据格式不正确"
            print(f"[即梦API] ❌ {error_msg}")
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
        
        # 构建建议信息
        suggestion = error_msg if '\n' in error_msg else (
            f"请检查:\n"
            f"1. 即梦服务是否在 {JIMENG_API_BASE_URL} 运行\n"
            f"2. SESSION_ID是否有效\n"
            f"3. 网络连接是否正常\n"
            f"4. 如果即梦API在其他地址，请设置环境变量 JIMENG_API_BASE_URL"
        )
        
        # 返回友好的错误信息
        return jsonify({
            "error": main_error,
            "status": "error",
            "suggestion": suggestion,
            "jimeng_api_url": JIMENG_API_BASE_URL
        }), 500

@app.route('/health', methods=['GET'])
def health():
    """健康检查接口"""
    return jsonify({
        "status": "ok",
        "service": "即梦API Mock服务器",
        "port": 5100,
        "jimeng_api_url": JIMENG_API_BASE_URL,
        "timeouts": {
            "connect": CONNECT_TIMEOUT,
            "read": READ_TIMEOUT
        }
    }), 200

@app.route('/', methods=['GET'])
def index():
    """首页"""
    return jsonify({
        "service": "即梦API Mock服务器",
        "version": "5.0.0",
        "description": "基于jm.py重构，不依赖Docker，直接使用SESSION_ID调用真实即梦API",
        "endpoints": {
            "POST /v1/images/generations": "生成图片（需要SESSION_ID）",
            "GET /health": "健康检查"
        },
        "config": {
            "jimeng_api_url": JIMENG_API_BASE_URL,
            "connect_timeout": CONNECT_TIMEOUT,
            "read_timeout": READ_TIMEOUT,
            "note": "此服务器使用SESSION_ID调用真实即梦API生成图片，兼容jm.py的调用方式"
        }
    }), 200

if __name__ == '__main__':
    print("\n" + "="*60)
    print("即梦API Mock服务器启动中...")
    print("="*60)
    print("服务地址: http://localhost:5100")
    print("API端点: POST http://localhost:5100/v1/images/generations")
    print("健康检查: GET http://localhost:5100/health")
    print("="*60)
    print(f"真实即梦API地址: {JIMENG_API_BASE_URL}")
    print(f"连接超时: {CONNECT_TIMEOUT}秒")
    print(f"读取超时: {READ_TIMEOUT}秒")
    print("="*60)
    print("\n说明:")
    print("  - 此服务器基于jm.py重构，不依赖Docker")
    print("  - 使用即梦SESSION_ID调用真实即梦API生成图片")
    print("  - 兼容jm.py的调用方式和响应格式")
    print("  - 需要在请求头中提供: Authorization: Bearer <SESSION_ID>")
    print("  - 如需修改即梦API地址，设置环境变量: JIMENG_API_BASE_URL")
    print("="*60)
    print("\n提示: 在网站中使用即梦模型生成图片")
    print("按 Ctrl+C 停止服务器\n")
    print("="*60 + "\n")
    
    # 启动服务器
    app.run(host='0.0.0.0', port=5100, debug=True)
