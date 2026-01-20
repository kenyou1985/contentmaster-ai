import requests
import time
import os
from PIL import Image
from io import BytesIO
import json

# ===================== 配置项（请根据你的实际情况修改） =====================
# 逆向API服务地址（Docker部署的地址）
API_BASE_URL = "http://localhost:5100/v1/images/generations"
# 你的即梦Web端sessionid（关键！从浏览器Cookie获取）
SESSION_ID = "6eac93ccd72cf4372558f38ee2a3161a"
# 生成图片的提示词（支持批量提示词）
PROMPTS = [
    "纯欲风，丰满沙漏身材，蕾丝长袜，紧身服饰，不露脸，9:16",
    "日系清新，白衬衫，校园风，逆光，16:9",
    "国风古韵，旗袍，江南水乡，水墨画风格，1:1"
]
# 每个提示词生成的图片数量
NUM_IMAGES_PER_PROMPT = 4
# 请求间隔（秒），避免高频请求被风控
REQUEST_INTERVAL = 10
# 图片保存目录
SAVE_DIR = ".jimeng_generated_images"
# ===========================================================================

# 创建保存目录
if not os.path.exists(SAVE_DIR):
    os.makedirs(SAVE_DIR)

def generate_images(prompt, num_images):
    """
    调用逆向API生成图片
    :param prompt: 生图提示词
    :param num_images: 生成数量
    :return: 图片URL列表或None
    """
    headers = {
        "Authorization": f"Bearer {SESSION_ID}",
        "Content-Type": "application/json"
    }
    data = {
        "prompt": prompt,
        "num_images": num_images,
        # 可选：添加尺寸参数，根据逆向API支持情况调整
        "width": 1080,
        "height": 1920
    }
    
    try:
        print(f"正在生成图片，提示词：{prompt}")
        response = requests.post(API_BASE_URL, headers=headers, json=data, timeout=60)
        response.raise_for_status()  # 抛出HTTP错误
        
        # 解析响应（根据逆向API的返回格式调整）
        result = response.json()
        if "data" in result and len(result["data"]) > 0:
            # 提取图片URL列表（假设返回格式是 {"data": [{"url": "xxx"}, ...]}）
            image_urls = [item["url"] for item in result["data"]]
            return image_urls
        else:
            print(f"生成失败，响应无图片数据：{result}")
            return None
    
    except requests.exceptions.RequestException as e:
        print(f"请求异常：{str(e)}")
        return None
    except json.JSONDecodeError as e:
        print(f"响应解析失败：{str(e)}，响应内容：{response.text}")
        return None

def download_image(image_url, save_path):
    """
    下载图片并保存
    :param image_url: 图片URL
    :param save_path: 保存路径
    """
    try:
        response = requests.get(image_url, timeout=30)
        response.raise_for_status()
        
        # 验证图片格式并保存
        img = Image.open(BytesIO(response.content))
        img.save(save_path)
        print(f"图片已保存：{save_path}")
    
    except Exception as e:
        print(f"下载图片失败 {image_url}：{str(e)}")

def batch_generate():
    """批量生成并下载图片"""
    total_count = 0
    for idx, prompt in enumerate(PROMPTS):
        # 生成图片
        image_urls = generate_images(prompt, NUM_IMAGES_PER_PROMPT)
        if not image_urls:
            print(f"跳过提示词：{prompt}")
            time.sleep(REQUEST_INTERVAL)
            continue
        
        # 下载每张图片
        for img_idx, img_url in enumerate(image_urls):
            save_filename = f"prompt_{idx+1}_img_{img_idx+1}_{int(time.time())}.jpg"
            save_path = os.path.join(SAVE_DIR, save_filename)
            download_image(img_url, save_path)
            total_count += 1
            # 图片下载间隔，避免过快
            time.sleep(2)
        
        # 提示词之间的请求间隔
        time.sleep(REQUEST_INTERVAL)
    
    print(f"批量生成完成，共生成 {total_count} 张图片，保存目录：{SAVE_DIR}")

if __name__ == "__main__":
    # 校验关键配置
    if SESSION_ID == "your_session_id_here":
        print("错误：请先替换配置项中的SESSION_ID！")
    else:
        batch_generate()
