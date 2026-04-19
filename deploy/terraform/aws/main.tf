##
# a2e-shell — ECS Fargate + ALB + EFS reference module.
#
# What this provisions:
#   - Fargate service behind an ALB with sticky cookie (session affinity).
#   - EFS mount at /sessions so session state survives task recycling on the
#     same task — not sharing across tasks (see note in variables.tf).
#   - CloudWatch log group for stdout.
#   - Secrets Manager entry for the bearer token.
#
# What this does NOT do (intentional):
#   - Create the VPC / subnets / ACM cert. Pass them in.
#   - Handle scaling policies. Add `aws_appautoscaling_*` if needed.
#   - Run multi-AZ EFS with POSIX locks compatible with a2e-shell's flock
#     assumptions — the catalog cache uses `open(..., 'wx')` which EFS
#     supports, but cross-AZ latency will hurt. Co-locate tasks + EFS mount
#     targets in one AZ if the workload is catalog-heavy.
##

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  name = var.name
  tags = merge(var.tags, { Project = "a2e-shell", ManagedBy = "terraform" })
}

# --- Secrets ---------------------------------------------------------------

resource "aws_secretsmanager_secret" "auth_token" {
  name = "${local.name}/auth-token"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "auth_token" {
  secret_id     = aws_secretsmanager_secret.auth_token.id
  secret_string = var.auth_token
}

# --- Logs ------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# --- IAM -------------------------------------------------------------------

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_exec" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "task_exec_managed" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "task_exec_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.auth_token.arn]
  }
}

resource "aws_iam_role_policy" "task_exec_secrets" {
  role   = aws_iam_role.task_exec.id
  policy = data.aws_iam_policy_document.task_exec_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = local.tags
}

# --- EFS -------------------------------------------------------------------

resource "aws_efs_file_system" "sessions" {
  creation_token   = "${local.name}-sessions"
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
  encrypted        = true
  tags             = local.tags
}

resource "aws_efs_mount_target" "sessions" {
  for_each        = toset(var.subnet_ids)
  file_system_id  = aws_efs_file_system.sessions.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "sessions" {
  file_system_id = aws_efs_file_system.sessions.id
  posix_user {
    uid = 10001
    gid = 10001
  }
  root_directory {
    path = "/sessions"
    creation_info {
      owner_uid   = 10001
      owner_gid   = 10001
      permissions = "0700"
    }
  }
  tags = local.tags
}

# --- Security groups -------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ingress for a2e-shell ALB"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "service" {
  name        = "${local.name}-service"
  description = "Fargate service — accepts traffic only from ALB"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "efs" {
  name        = "${local.name}-efs"
  description = "EFS — accepts NFS from Fargate service only"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
}

# --- ALB -------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = local.name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  idle_timeout       = 300  # SSE streams
  tags               = local.tags
}

resource "aws_lb_target_group" "this" {
  name        = local.name
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 10
    timeout             = 3
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  # Sticky cookie for session affinity. See README note: sessions are local
  # per task, so clients MUST propagate this cookie across their exec calls.
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 3600
    enabled         = true
  }

  tags = local.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

# --- ECS -------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.name
  tags = local.tags
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task.arn

  volume {
    name = "sessions"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.sessions.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.sessions.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([{
    name      = "a2e-shell"
    image     = var.image
    essential = true
    portMappings = [{
      containerPort = 8080
      protocol      = "tcp"
    }]
    environment = [
      { name = "A2E_PORT",                         value = "8080" },
      { name = "A2E_SESSIONS_DIR",                 value = "/sessions" },
      { name = "A2E_MAX_REQUEST_BYTES",            value = "1048576" },
      { name = "A2E_RATE_LIMIT_PER_MINUTE",        value = "120" },
      { name = "A2E_RATE_LIMIT_CREATE_PER_MINUTE", value = "20" },
      { name = "A2E_GRACE_PERIOD_MS",              value = "25000" },
      { name = "A2E_LOG_LEVEL",                    value = "info" },
    ]
    secrets = [
      { name = "A2E_AUTH_TOKENS", valueFrom = aws_secretsmanager_secret.auth_token.arn },
    ]
    mountPoints = [{
      sourceVolume  = "sessions"
      containerPath = "/sessions"
      readOnly      = false
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ecs"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/healthz || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "this" {
  name            = local.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "a2e-shell"
    container_port   = 8080
  }

  # ECS gives the task A2E_GRACE_PERIOD_MS (25s) to drain before SIGKILL.
  # Keep stopTimeout strictly above that in seconds.
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  health_check_grace_period_seconds  = 30

  depends_on = [aws_lb_listener.https]

  tags = local.tags
}
