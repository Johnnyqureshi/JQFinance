import os
import logging
import requests
from flask import Blueprint, render_template, request, jsonify
from flask_login import login_required, current_user
from extensions import db
from models import VideoGeneration

ai_studio_bp = Blueprint("ai_studio", __name__)
logger = logging.getLogger("ai_studio")

AIML_API_BASE = "https://api.aimlapi.com/v2"
AIML_API_KEY = os.environ.get("AIML_API_KEY", "")


def get_aiml_headers():
    return {
        "Authorization": f"Bearer {AIML_API_KEY}",
        "Content-Type": "application/json"
    }


@ai_studio_bp.route("/ai-studio")
@login_required
def ai_studio():
    generations = VideoGeneration.query.filter_by(
        user_id=current_user.id
    ).order_by(VideoGeneration.created_at.desc()).limit(20).all()
    return render_template("ai_studio.html", active_tab="ai_studio", generations=generations)


@ai_studio_bp.route("/api/ai-studio/text-to-video", methods=["POST"])
@login_required
def text_to_video():
    try:
        if not AIML_API_KEY:
            return jsonify({"status": "error", "message": "AI/ML API key not configured. Please add AIML_API_KEY to your secrets."})

        data = request.json
        prompt = data.get("prompt", "").strip()
        negative_prompt = data.get("negative_prompt", "").strip()
        aspect_ratio = data.get("aspect_ratio", "16:9")
        duration = int(data.get("duration", 5))
        cfg_scale = float(data.get("cfg_scale", 0.5))

        if not prompt:
            return jsonify({"status": "error", "message": "Please enter a prompt."})

        if aspect_ratio not in ["16:9", "9:16", "1:1"]:
            aspect_ratio = "16:9"

        if duration not in [5, 10]:
            duration = 5

        payload = {
            "model": "klingai/v2-master-text-to-video",
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "duration": str(duration),
            "cfg_scale": cfg_scale
        }

        if negative_prompt:
            payload["negative_prompt"] = negative_prompt

        headers = get_aiml_headers()
        url = f"{AIML_API_BASE}/generate/video/kling/generation"

        response = requests.post(url, json=payload, headers=headers, timeout=30)

        if response.status_code >= 400:
            logger.error(f"AIML API error: {response.status_code} - {response.text}")
            return jsonify({"status": "error", "message": f"API error: {response.text}"})

        result = response.json()
        gen_id = result.get("id")

        if not gen_id:
            return jsonify({"status": "error", "message": "Failed to start video generation."})

        record = VideoGeneration(
            user_id=current_user.id,
            generation_id=gen_id,
            mode="text-to-video",
            prompt=prompt,
            negative_prompt=negative_prompt if negative_prompt else None,
            aspect_ratio=aspect_ratio,
            duration=duration,
            cfg_scale=cfg_scale,
            status="generating"
        )
        db.session.add(record)
        db.session.commit()

        return jsonify({
            "status": "success",
            "generation_id": gen_id,
            "message": "Video generation started. This may take 5-14 minutes."
        })

    except Exception as e:
        logger.error(f"Text-to-video error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@ai_studio_bp.route("/api/ai-studio/image-to-video", methods=["POST"])
@login_required
def image_to_video():
    try:
        if not AIML_API_KEY:
            return jsonify({"status": "error", "message": "AI/ML API key not configured. Please add AIML_API_KEY to your secrets."})

        data = request.json
        prompt = data.get("prompt", "").strip()
        image_url = data.get("image_url", "").strip()
        negative_prompt = data.get("negative_prompt", "").strip()
        aspect_ratio = data.get("aspect_ratio", "16:9")
        duration = int(data.get("duration", 5))
        cfg_scale = float(data.get("cfg_scale", 0.5))

        if not image_url:
            return jsonify({"status": "error", "message": "Please provide an image URL."})

        if aspect_ratio not in ["16:9", "9:16", "1:1"]:
            aspect_ratio = "16:9"

        if duration not in [5, 10]:
            duration = 5

        payload = {
            "model": "klingai/v2-master-image-to-video",
            "image_url": image_url,
            "aspect_ratio": aspect_ratio,
            "duration": str(duration),
            "cfg_scale": cfg_scale
        }

        if prompt:
            payload["prompt"] = prompt

        if negative_prompt:
            payload["negative_prompt"] = negative_prompt

        headers = get_aiml_headers()
        url = f"{AIML_API_BASE}/generate/video/kling/generation"

        response = requests.post(url, json=payload, headers=headers, timeout=30)

        if response.status_code >= 400:
            logger.error(f"AIML API error: {response.status_code} - {response.text}")
            return jsonify({"status": "error", "message": f"API error: {response.text}"})

        result = response.json()
        gen_id = result.get("id")

        if not gen_id:
            return jsonify({"status": "error", "message": "Failed to start video generation."})

        record = VideoGeneration(
            user_id=current_user.id,
            generation_id=gen_id,
            mode="image-to-video",
            prompt=prompt if prompt else None,
            negative_prompt=negative_prompt if negative_prompt else None,
            image_url=image_url,
            aspect_ratio=aspect_ratio,
            duration=duration,
            cfg_scale=cfg_scale,
            status="generating"
        )
        db.session.add(record)
        db.session.commit()

        return jsonify({
            "status": "success",
            "generation_id": gen_id,
            "message": "Video generation started. This may take 5-14 minutes."
        })

    except Exception as e:
        logger.error(f"Image-to-video error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@ai_studio_bp.route("/api/ai-studio/status/<generation_id>")
@login_required
def check_status(generation_id):
    try:
        headers = get_aiml_headers()
        url = f"{AIML_API_BASE}/generate/video/kling/generation"
        params = {"generation_id": generation_id}

        response = requests.get(url, params=params, headers=headers, timeout=30)

        if response.status_code >= 400:
            return jsonify({"status": "error", "message": f"API error: {response.text}"})

        result = response.json()
        status = result.get("status", "unknown")

        record = VideoGeneration.query.filter_by(
            generation_id=generation_id,
            user_id=current_user.id
        ).first()

        if record:
            record.status = status
            if status == "completed":
                video_data = result.get("video", {})
                record.video_url = video_data.get("url")
                record.file_size = video_data.get("file_size")
            elif status == "failed":
                error_data = result.get("error", {})
                record.error_message = error_data.get("message", "Unknown error")
            db.session.commit()

        video_url = None
        if status == "completed":
            video_data = result.get("video", {})
            video_url = video_data.get("url")

        error_message = None
        if status == "failed":
            error_data = result.get("error", {})
            error_message = error_data.get("message")

        return jsonify({
            "status": status,
            "video_url": video_url,
            "error_message": error_message
        })

    except Exception as e:
        logger.error(f"Status check error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@ai_studio_bp.route("/api/ai-studio/history")
@login_required
def generation_history():
    generations = VideoGeneration.query.filter_by(
        user_id=current_user.id
    ).order_by(VideoGeneration.created_at.desc()).limit(20).all()

    results = []
    for gen in generations:
        results.append({
            "id": gen.id,
            "generation_id": gen.generation_id,
            "mode": gen.mode,
            "prompt": gen.prompt,
            "status": gen.status,
            "video_url": gen.video_url,
            "aspect_ratio": gen.aspect_ratio,
            "duration": gen.duration,
            "created_at": gen.created_at.strftime("%Y-%m-%d %H:%M") if gen.created_at else None
        })

    return jsonify({"generations": results})
