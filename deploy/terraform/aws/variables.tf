variable "name" {
  description = "Resource name prefix."
  type        = string
  default     = "a2e-shell"
}

variable "region" {
  description = "AWS region for log group / ECS. Provider region should match."
  type        = string
}

variable "image" {
  description = "Full image reference, e.g. ghcr.io/mauricioperera/a2e-shell:v1.0.0."
  type        = string
}

variable "vpc_id" {
  description = "VPC in which to deploy ALB, ECS, EFS."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets for Fargate tasks + EFS mount targets. Pick one AZ if catalog-cache locality matters."
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB."
  type        = list(string)
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener."
  type        = string
}

variable "auth_token" {
  description = "Bearer token written to Secrets Manager. Rotate via a new tfvars or a separate secret-rotation Lambda."
  type        = string
  sensitive   = true
}

variable "desired_count" {
  description = "Fargate task count. Note: sessions are local per task — scaling out only helps new sessions."
  type        = number
  default     = 2
}

variable "task_cpu" {
  description = "Fargate task CPU units (256, 512, 1024, 2048, 4096)."
  type        = string
  default     = "1024"
}

variable "task_memory" {
  description = "Fargate task memory in MiB. Must match the CPU/memory matrix."
  type        = string
  default     = "2048"
}

variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to reach the ALB on 443. Default is world; tighten if behind a CDN/WAF."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 14
}

variable "tags" {
  description = "Extra tags to merge into every resource."
  type        = map(string)
  default     = {}
}
